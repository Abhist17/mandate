// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IPerpVenue} from "../interfaces/IPerpVenue.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {Types} from "../libraries/Types.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title MiniPerp
/// @author Mandate
/// @notice A minimal oracle-priced perp venue with isolated margin and linear funding.
///
/// @dev **Why this exists.** Perpl is live on Monad testnet and it is a better exchange than
///      this will ever be. But Perpl orders are Ed25519-signed over an authenticated
///      WebSocket, and it does not support EIP-1271 contract signatures — so a smart contract
///      cannot open or close a Perpl position. Mandate's entire claim is that *the contract*
///      flattens a breached position and anyone can trigger it. Routing that through an
///      off-chain keyholder would rebuild the trusted private risk server this project exists
///      to remove. So the venue has to be onchain. See docs/PHASE1-FINDINGS.md §2.
///
///      **Fidelity.** MiniPerp mirrors Perpl's live testnet market configuration — same
///      markets, comparable margin requirements, fee tiers and funding cadence — and marks
///      against Perpl's own oracle price, relayed onchain by the keeper. A mandate run here
///      faces the same economics a trader would face on Perpl proper.
///
///      **What it is not.** No order book, no maker side, no partial fills, no cross margin,
///      no ADL. Fills are oracle-priced with a spread-plus-linear-impact model. It is a
///      settlement venue for testing risk enforcement, not a competitive exchange.
///
///      **Scales.** size 1e18 (base units) · price 1e8 (USD) · collateral in asset decimals.
///      notional = size * price / 1e20, which lands in asset units for a 6-decimal asset.
contract MiniPerp is IPerpVenue, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    /// @dev Fees are quoted in millionths of notional, matching Perpl's config integers:
    ///      690 -> 0.069% taker, 90 -> 0.009% maker.
    uint256 internal constant FEE_SCALE = 1_000_000;
    uint256 internal constant FUNDING_SCALE = 1e18;
    /// @dev size(1e18) * price(1e8) / 1e20 == notional in a 6-decimal asset.
    uint256 internal constant NOTIONAL_DIVISOR = 1e20;

    /// @notice Positions an account may hold at once.
    /// @dev Bounded so {flatten} is a single transaction with a known worst-case gas cost.
    ///      An enforcement path that could run out of gas is not an enforcement path.
    uint256 public constant MAX_OPEN_POSITIONS = 4;

    struct Market {
        bool listed;
        bool open;
        uint16 initialMarginBps; // margin required, as bps of notional
        uint16 maintenanceMarginBps; // liquidation threshold, bps of notional
        uint32 takerFeeMicros; // fee on notional, millionths
        uint16 halfSpreadBps; // half-spread applied against the taker
        uint256 impactDepth; // notional (asset units) that moves price 1%
        uint256 minSize; // smallest tradeable size, 1e18
        int256 fundingIndex; // cumulative funding per unit notional, 1e18
        uint64 lastFundingAt;
        int32 fundingRateMicros; // per funding interval, millionths of notional
        uint32 fundingIntervalSec;
        uint256 openInterestLong; // notional
        uint256 openInterestShort; // notional
    }

    /// @notice The ERC-20 this venue settles in.
    IERC20 public immutable assetToken;
    IPriceOracle public oracle;

    /// @notice Max age of an oracle price for any state-changing operation.
    uint64 public maxPriceAge = 60;

    /// @notice Addresses permitted to call {flatten}. The MandateRegistry holds this.
    mapping(address => bool) public flatteners;

    /// @notice Asset backing the venue's obligations beyond posted collateral.
    ///
    /// @dev A real exchange pays a winning long out of a losing short. MiniPerp has no order
    ///      book and no natural counterparty — each mandate account trades against the venue
    ///      itself — so a profitable position has to be paid from somewhere. That somewhere
    ///      is this reserve, which is the same role an exchange insurance fund plays.
    ///
    ///      Stated plainly because it is a real property of the design, not an oversight:
    ///      MiniPerp is a settlement venue for testing risk enforcement, and its solvency is
    ///      an assumption rather than a market outcome. Losing positions pay into it and
    ///      winning ones draw from it; if it empties, withdrawals revert with
    ///      {Errors-InsufficientVenueLiquidity} rather than failing as an opaque ERC-20 error.
    uint256 public reserveContributed;

    mapping(uint16 => Market) internal _markets;
    mapping(address => uint256) internal _freeCollateral;
    mapping(address => mapping(uint16 => Types.Position)) internal _positions;
    mapping(address => uint16[]) internal _openMarkets;

    uint16[] public listedMarkets;

    event MarketListed(uint16 indexed marketId, uint16 initialMarginBps, uint16 maintenanceMarginBps);
    event MarketStatusSet(uint16 indexed marketId, bool open);
    event Deposited(address indexed account, uint256 amount);
    event ReserveFunded(address indexed by, uint256 amount, uint256 totalContributed);
    event Withdrawn(address indexed account, uint256 amount);
    event PositionOpened(
        address indexed account,
        uint16 indexed marketId,
        bool isLong,
        uint256 size,
        uint256 fillPrice,
        uint256 notional,
        uint256 margin,
        uint256 fee
    );
    event PositionClosed(
        address indexed account,
        uint16 indexed marketId,
        uint256 size,
        uint256 fillPrice,
        int256 realisedPnl,
        uint256 fee,
        int256 funding
    );
    event Flattened(address indexed account, address indexed by, int256 realisedPnl, uint256 positionsClosed);
    event Liquidated(address indexed account, uint16 indexed marketId, address indexed by, int256 realisedPnl);
    event FundingAccrued(uint16 indexed marketId, int256 fundingIndex, uint64 at);
    event FlattenerSet(address indexed who, bool allowed);
    event OracleSet(address indexed oracle);

    constructor(address owner_, address asset_, address oracle_) Ownable(owner_) {
        if (asset_ == address(0) || oracle_ == address(0)) revert Errors.ZeroAddress();
        assetToken = IERC20(asset_);
        oracle = IPriceOracle(oracle_);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Admin
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice List a market. Parameters mirror Perpl's live testnet config.
    function listMarket(
        uint16 marketId,
        uint16 initialMarginBps,
        uint16 maintenanceMarginBps,
        uint32 takerFeeMicros,
        uint16 halfSpreadBps,
        uint256 impactDepth,
        uint256 minSize,
        int32 fundingRateMicros,
        uint32 fundingIntervalSec
    ) external onlyOwner {
        Market storage m = _markets[marketId];
        if (m.listed) revert Errors.MarketAlreadyListed(marketId);
        if (initialMarginBps == 0 || initialMarginBps > BPS) revert Errors.BpsOutOfRange(initialMarginBps);
        // Maintenance below initial, or a position is liquidatable the moment it opens.
        if (maintenanceMarginBps == 0 || maintenanceMarginBps >= initialMarginBps) {
            revert Errors.BpsOutOfRange(maintenanceMarginBps);
        }
        if (impactDepth == 0 || fundingIntervalSec == 0) revert Errors.ZeroAmount();

        m.listed = true;
        m.open = true;
        m.initialMarginBps = initialMarginBps;
        m.maintenanceMarginBps = maintenanceMarginBps;
        m.takerFeeMicros = takerFeeMicros;
        m.halfSpreadBps = halfSpreadBps;
        m.impactDepth = impactDepth;
        m.minSize = minSize;
        m.fundingRateMicros = fundingRateMicros;
        m.fundingIntervalSec = fundingIntervalSec;
        m.lastFundingAt = uint64(block.timestamp);

        listedMarkets.push(marketId);
        emit MarketListed(marketId, initialMarginBps, maintenanceMarginBps);
    }

    function setMarketOpen(uint16 marketId, bool open) external onlyOwner {
        if (!_markets[marketId].listed) revert Errors.UnknownMarket(marketId);
        _markets[marketId].open = open;
        emit MarketStatusSet(marketId, open);
    }

    /// @notice Update a market's funding rate. Mirrors Perpl's published rate.
    function setFundingRate(uint16 marketId, int32 fundingRateMicros) external onlyOwner {
        if (!_markets[marketId].listed) revert Errors.UnknownMarket(marketId);
        _accrueFunding(marketId);
        _markets[marketId].fundingRateMicros = fundingRateMicros;
    }

    /// @notice Grant or revoke the right to call {flatten}.
    /// @dev Held by MandateRegistry so enforcement can close positions it does not own.
    function setFlattener(address who, bool allowed) external onlyOwner {
        if (who == address(0)) revert Errors.ZeroAddress();
        flatteners[who] = allowed;
        emit FlattenerSet(who, allowed);
    }

    function setOracle(address oracle_) external onlyOwner {
        if (oracle_ == address(0)) revert Errors.ZeroAddress();
        oracle = IPriceOracle(oracle_);
        emit OracleSet(oracle_);
    }

    function setMaxPriceAge(uint64 age) external onlyOwner {
        if (age == 0) revert Errors.ZeroAmount();
        maxPriceAge = age;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Collateral
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IPerpVenue
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert Errors.ZeroAmount();
        assetToken.safeTransferFrom(msg.sender, address(this), amount);
        _freeCollateral[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Contribute to the venue's reserve. Permissionless — anyone may backstop it.
    /// @dev See {reserveContributed} for why a venue with no order book needs one at all.
    function fundReserve(uint256 amount) external nonReentrant {
        if (amount == 0) revert Errors.ZeroAmount();
        assetToken.safeTransferFrom(msg.sender, address(this), amount);
        reserveContributed += amount;
        emit ReserveFunded(msg.sender, amount, reserveContributed);
    }

    /// @inheritdoc IPerpVenue
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert Errors.ZeroAmount();
        uint256 free = _freeCollateral[msg.sender];
        if (amount > free) revert Errors.InsufficientMargin(amount, free);

        // Fail loudly if the reserve cannot cover a winning position, rather than surfacing
        // an opaque ERC-20 balance error from three calls deep.
        uint256 held = assetToken.balanceOf(address(this));
        if (amount > held) revert Errors.InsufficientVenueLiquidity(amount, held);

        _freeCollateral[msg.sender] = free - amount;
        assetToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Asset the venue holds right now.
    function liquidity() external view returns (uint256) {
        return assetToken.balanceOf(address(this));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Trading
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IPerpVenue
    /// @dev Adding to an existing position blends the entry price and settles accrued funding
    ///      into the new snapshot, so funding is never silently forgiven by topping up.
    function openPosition(uint16 marketId, bool isLong, uint256 size, uint256 limitPrice)
        external
        nonReentrant
        returns (uint256 fillPrice)
    {
        Market storage m = _requireOpenMarket(marketId);
        if (size < m.minSize) revert Errors.SizeTooSmall(size, m.minSize);

        _accrueFunding(marketId);
        uint256 mark = oracle.priceNoOlderThan(marketId, maxPriceAge);
        uint256 notional = _notional(size, mark);
        fillPrice = _executionPrice(m, mark, notional, isLong);

        if (limitPrice != 0) {
            if (isLong ? fillPrice > limitPrice : fillPrice < limitPrice) {
                revert Errors.SlippageExceeded(fillPrice, limitPrice);
            }
        }

        uint256 filledNotional = _notional(size, fillPrice);
        uint256 fee = (filledNotional * m.takerFeeMicros) / FEE_SCALE;
        uint256 margin = (filledNotional * m.initialMarginBps) / BPS;

        Types.Position storage p = _positions[msg.sender][marketId];
        if (p.size == 0) {
            if (_openMarkets[msg.sender].length >= MAX_OPEN_POSITIONS) {
                revert Errors.PositionAlreadyOpen(msg.sender, marketId);
            }
            _openMarkets[msg.sender].push(marketId);
            p.marketId = marketId;
            p.isLong = isLong;
            p.entryPrice = fillPrice;
            p.openedAt = uint64(block.timestamp);
            p.fundingIndexAtEntry = m.fundingIndex;
        } else {
            // v1 keeps direction fixed per market; reversing means closing first. Netting a
            // flip inside one call would make the position cap ambiguous mid-trade.
            if (p.isLong != isLong) revert Errors.PositionAlreadyOpen(msg.sender, marketId);
            // Settle funding owed so far into the position's margin before re-snapshotting.
            int256 owed = _fundingOwed(p, m.fundingIndex);
            _applyToMargin(p, owed);
            p.entryPrice = ((p.entryPrice * p.size) + (fillPrice * size)) / (p.size + size);
            p.fundingIndexAtEntry = m.fundingIndex;
        }

        uint256 debit = margin + fee;
        uint256 free = _freeCollateral[msg.sender];
        if (debit > free) revert Errors.InsufficientMargin(debit, free);
        _freeCollateral[msg.sender] = free - debit;

        p.size += size;
        p.margin += margin;

        if (isLong) m.openInterestLong += filledNotional;
        else m.openInterestShort += filledNotional;

        emit PositionOpened(msg.sender, marketId, isLong, size, fillPrice, filledNotional, margin, fee);
    }

    /// @inheritdoc IPerpVenue
    function closePosition(uint16 marketId, uint256 limitPrice)
        external
        nonReentrant
        returns (int256 realisedPnl)
    {
        return _close(msg.sender, marketId, limitPrice);
    }

    /// @inheritdoc IPerpVenue
    /// @dev Slippage limits are ignored on purpose — see {IPerpVenue-flatten}.
    function flatten(address account) external nonReentrant returns (int256 realisedPnl) {
        if (!flatteners[msg.sender] && msg.sender != account) revert Errors.NotAuthorised(msg.sender);

        uint16[] memory open = _openMarkets[account];
        uint256 n = open.length;
        // Iterate a memory copy and close by id: _close mutates _openMarkets as it goes.
        for (uint256 i; i < n; ++i) {
            realisedPnl += _close(account, open[i], 0);
        }
        emit Flattened(account, msg.sender, realisedPnl, n);
    }

    /// @notice Liquidate a position whose margin has fallen below maintenance.
    /// @dev Permissionless, like {MandateRegistry-markAndEnforce}. In practice a mandate's
    ///      drawdown floor bites long before venue maintenance margin does; this is the
    ///      backstop for a position held outside a mandate.
    function liquidate(address account, uint16 marketId) external nonReentrant returns (int256 realisedPnl) {
        Types.Position storage p = _positions[account][marketId];
        if (p.size == 0) revert Errors.NoOpenPosition(account, marketId);

        Market storage m = _markets[marketId];
        _accrueFunding(marketId);
        uint256 mark = oracle.priceNoOlderThan(marketId, maxPriceAge);

        int256 equity = int256(p.margin) + _positionPnl(p, mark) + _fundingOwed(p, m.fundingIndex);
        uint256 maintenance = (_notional(p.size, mark) * m.maintenanceMarginBps) / BPS;
        if (equity > int256(maintenance)) revert Errors.InsufficientMargin(maintenance, uint256(equity));

        realisedPnl = _close(account, marketId, 0);
        emit Liquidated(account, marketId, msg.sender, realisedPnl);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Internal mechanics
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Scoped into blocks rather than compiled with via-ir: the close path is the one
    ///      enforcement depends on, and keeping it legacy-pipeline keeps the bytecode simple
    ///      to reason about and the test cycle fast.
    function _close(address account, uint16 marketId, uint256 limitPrice) internal returns (int256 realisedPnl) {
        Types.Position storage p = _positions[account][marketId];
        if (p.size == 0) revert Errors.NoOpenPosition(account, marketId);

        _accrueFunding(marketId);

        // Closing is the opposite side of opening, so the spread works against the closer too.
        uint256 fillPrice;
        {
            Market storage m = _markets[marketId];
            uint256 mark = oracle.priceNoOlderThan(marketId, maxPriceAge);
            fillPrice = _executionPrice(m, mark, _notional(p.size, mark), !p.isLong);
        }

        if (limitPrice != 0) {
            if (p.isLong ? fillPrice < limitPrice : fillPrice > limitPrice) {
                revert Errors.SlippageExceeded(fillPrice, limitPrice);
            }
        }

        uint256 fee;
        int256 funding;
        {
            Market storage m = _markets[marketId];
            fee = (_notional(p.size, fillPrice) * m.takerFeeMicros) / FEE_SCALE;
            funding = _fundingOwed(p, m.fundingIndex);
        }
        realisedPnl = _positionPnl(p, fillPrice) + funding - int256(fee);

        // Return margin adjusted by the result, floored at zero: a loss larger than the margin
        // posted is the venue's bad debt, not a negative balance on the account.
        {
            int256 returned = int256(p.margin) + realisedPnl;
            _freeCollateral[account] += returned > 0 ? uint256(returned) : 0;
        }

        _releaseOpenInterest(p, marketId);

        emit PositionClosed(account, marketId, p.size, fillPrice, realisedPnl, fee, funding);

        delete _positions[account][marketId];
        _removeOpenMarket(account, marketId);
    }

    /// @dev Unwind a position's contribution to open interest. Must run before the delete.
    function _releaseOpenInterest(Types.Position storage p, uint16 marketId) internal {
        Market storage m = _markets[marketId];
        uint256 entryNotional = _notional(p.size, p.entryPrice);
        if (p.isLong) {
            m.openInterestLong = m.openInterestLong > entryNotional ? m.openInterestLong - entryNotional : 0;
        } else {
            m.openInterestShort = m.openInterestShort > entryNotional ? m.openInterestShort - entryNotional : 0;
        }
    }

    /// @dev Fill price = mark, moved against the taker by a half-spread plus linear impact.
    ///      impactBps = notional * 100 / impactDepth, i.e. `impactDepth` of notional moves
    ///      the price 1%. Crude but monotonic in size, which is the property that matters:
    ///      a bigger order always gets a worse fill, so size cannot be free.
    function _executionPrice(Market storage m, uint256 mark, uint256 notional, bool isBuy)
        internal
        view
        returns (uint256)
    {
        uint256 impactBps = (notional * 100) / m.impactDepth;
        uint256 adverseBps = uint256(m.halfSpreadBps) + impactBps;
        return isBuy ? (mark * (BPS + adverseBps)) / BPS : (mark * (BPS - adverseBps)) / BPS;
    }

    /// @dev Linear funding. The index accumulates `rate` millionths of notional per interval;
    ///      longs pay shorts when positive.
    function _accrueFunding(uint16 marketId) internal {
        Market storage m = _markets[marketId];
        uint64 nowTs = uint64(block.timestamp);
        uint64 elapsed = nowTs - m.lastFundingAt;
        if (elapsed == 0) return;

        int256 delta = (int256(m.fundingRateMicros) * int256(uint256(elapsed)) * int256(FUNDING_SCALE))
            / (int256(uint256(m.fundingIntervalSec)) * int256(FEE_SCALE));
        m.fundingIndex += delta;
        m.lastFundingAt = nowTs;
        emit FundingAccrued(marketId, m.fundingIndex, nowTs);
    }

    /// @dev Funding a position owes (negative) or is owed (positive) since entry.
    function _fundingOwed(Types.Position storage p, int256 currentIndex) internal view returns (int256) {
        int256 drift = currentIndex - p.fundingIndexAtEntry;
        if (drift == 0) return 0;
        int256 notionalAtEntry = int256(_notional(p.size, p.entryPrice));
        int256 amount = (drift * notionalAtEntry) / int256(FUNDING_SCALE);
        return p.isLong ? -amount : amount;
    }

    /// @dev Fold a signed amount into a position's posted margin, floored at zero.
    function _applyToMargin(Types.Position storage p, int256 amount) internal {
        if (amount == 0) return;
        if (amount > 0) {
            p.margin += uint256(amount);
        } else {
            uint256 debit = uint256(-amount);
            p.margin = p.margin > debit ? p.margin - debit : 0;
        }
    }

    function _positionPnl(Types.Position storage p, uint256 mark) internal view returns (int256) {
        int256 diff = int256(mark) - int256(p.entryPrice);
        int256 raw = (diff * int256(p.size)) / int256(NOTIONAL_DIVISOR);
        return p.isLong ? raw : -raw;
    }

    function _notional(uint256 size, uint256 priceE8) internal pure returns (uint256) {
        return (size * priceE8) / NOTIONAL_DIVISOR;
    }

    function _requireOpenMarket(uint16 marketId) internal view returns (Market storage m) {
        m = _markets[marketId];
        if (!m.listed) revert Errors.UnknownMarket(marketId);
        if (!m.open) revert Errors.MarketClosed(marketId);
    }

    function _removeOpenMarket(address account, uint16 marketId) internal {
        uint16[] storage arr = _openMarkets[account];
        uint256 n = arr.length;
        for (uint256 i; i < n; ++i) {
            if (arr[i] == marketId) {
                arr[i] = arr[n - 1];
                arr.pop();
                return;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Views
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IPerpVenue
    function accountEquity(address account) external view returns (uint256) {
        int256 total = int256(_freeCollateral[account]);
        uint16[] memory open = _openMarkets[account];
        for (uint256 i; i < open.length; ++i) {
            Types.Position storage p = _positions[account][open[i]];
            (uint256 mark,) = oracle.price(open[i]);
            total += int256(p.margin) + _positionPnl(p, mark) + _fundingOwed(p, _markets[open[i]].fundingIndex);
        }
        return total > 0 ? uint256(total) : 0;
    }

    /// @inheritdoc IPerpVenue
    function unrealisedPnl(address account) public view returns (int256 total) {
        uint16[] memory open = _openMarkets[account];
        for (uint256 i; i < open.length; ++i) {
            Types.Position storage p = _positions[account][open[i]];
            (uint256 mark,) = oracle.price(open[i]);
            total += _positionPnl(p, mark) + _fundingOwed(p, _markets[open[i]].fundingIndex);
        }
    }

    /// @inheritdoc IPerpVenue
    function totalNotional(address account) external view returns (uint256 total) {
        uint16[] memory open = _openMarkets[account];
        for (uint256 i; i < open.length; ++i) {
            Types.Position storage p = _positions[account][open[i]];
            (uint256 mark,) = oracle.price(open[i]);
            total += _notional(p.size, mark);
        }
    }

    /// @inheritdoc IPerpVenue
    function quoteNotional(uint16 marketId, uint256 size) external view returns (uint256) {
        (uint256 mark,) = oracle.price(marketId);
        return _notional(size, mark);
    }

    /// @inheritdoc IPerpVenue
    function getPosition(address account, uint16 marketId) external view returns (Types.Position memory) {
        return _positions[account][marketId];
    }

    /// @inheritdoc IPerpVenue
    function openMarkets(address account) external view returns (uint16[] memory) {
        return _openMarkets[account];
    }

    /// @inheritdoc IPerpVenue
    function freeCollateral(address account) external view returns (uint256) {
        return _freeCollateral[account];
    }

    /// @inheritdoc IPerpVenue
    function asset() external view returns (address) {
        return address(assetToken);
    }

    function market(uint16 marketId) external view returns (Market memory) {
        return _markets[marketId];
    }

    function listedMarketCount() external view returns (uint256) {
        return listedMarkets.length;
    }

    /// @notice Price an order would fill at right now, including spread and impact.
    /// @dev The frontend quotes with this so the trader sees the real fill before signing.
    function previewFill(uint16 marketId, uint256 size, bool isBuy) external view returns (uint256) {
        Market storage m = _markets[marketId];
        if (!m.listed) revert Errors.UnknownMarket(marketId);
        (uint256 mark,) = oracle.price(marketId);
        return _executionPrice(m, mark, _notional(size, mark), isBuy);
    }
}

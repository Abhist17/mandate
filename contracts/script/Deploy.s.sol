// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {PriceOracle} from "../src/oracle/PriceOracle.sol";
import {MiniPerp} from "../src/venue/MiniPerp.sol";
import {MandateAccount} from "../src/MandateAccount.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {CapitalPool} from "../src/CapitalPool.sol";
import {MockERC20} from "../test/utils/MockERC20.sol";

/// @title Deploy
/// @notice Deploys the full Mandate system to Monad testnet with the SPEC §7 defaults:
///         10% max drawdown, 5% daily loss, 80/20 split, 3x position cap.
///
/// @dev Market parameters mirror Perpl's live Monad testnet configuration, recorded in
///      docs/PHASE1-FINDINGS.md — same market ids (BTC 16, ETH 32, SOL 48), same 0.069%
///      taker fee, same 2580s funding interval. The keeper relays Perpl's oracle price into
///      {PriceOracle}, so mandates are marked against real market prices.
///
///      Run:
///        forge script script/Deploy.s.sol:Deploy \
///          --rpc-url $MONAD_TESTNET_RPC --broadcast --legacy -vvv
contract Deploy is Script {
    // Perpl's real testnet market ids.
    uint16 constant BTC = 16;
    uint16 constant ETH = 32;
    uint16 constant SOL = 48;

    uint256 constant ONE = 1e6; // 6-decimal collateral, matching AUSD

    /// @notice Pyth on Monad testnet. Verified live — docs/PHASE1-FINDINGS.md §4.
    address constant PYTH_MONAD_TESTNET = 0x2880aB155794e7179c9eE2e38200202908C17B43;

    /// @notice Seeded into the venue so profitable mandates can be paid out.
    /// @dev MiniPerp has no order book and therefore no natural counterparty.
    ///      See {MiniPerp-reserveContributed}.
    uint256 constant VENUE_RESERVE = 2_000_000 * ONE;

    /// @notice Seeded into the pool as LP capital for the demo.
    uint256 constant POOL_SEED = 5_000_000 * ONE;

    /// @dev Held as state rather than passed around: the writer needs eight addresses and
    ///      Solidity's legacy pipeline runs out of stack slots well before that.
    struct Deployed {
        address asset;
        address oracle;
        address venue;
        address accountImpl;
        address registry;
        address pool;
        address deployer;
        address keeper;
    }

    Deployed internal d;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address keeper = vm.envOr("KEEPER_ADDRESS", deployer);

        console2.log("Deployer :", deployer);
        console2.log("Keeper   :", keeper);
        console2.log("Chain    :", block.chainid);

        vm.startBroadcast(pk);

        // ── collateral ────────────────────────────────────────────────────────────
        // Testnet uses a faucet-mintable stand-in for AUSD so judges and testers can get
        // funded without hunting for testnet AUSD. On mainnet this would be the real token
        // at 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC.
        address assetAddr = vm.envOr("POOL_ASSET_ADDRESS", address(0));
        MockERC20 assetToken;
        if (assetAddr == address(0)) {
            assetToken = new MockERC20("Mandate USD", "mUSD", 6);
            console2.log("Asset (deployed):", address(assetToken));
        } else {
            assetToken = MockERC20(assetAddr);
            console2.log("Asset (existing):", address(assetToken));
        }

        // ── oracle ────────────────────────────────────────────────────────────────
        PriceOracle oracle = new PriceOracle(deployer, PYTH_MONAD_TESTNET);
        oracle.setPublisher(keeper, true);

        // 60s staleness bound: at 400ms blocks that is ~150 blocks of slack, and it is tight
        // enough that a dead keeper halts trading rather than marking against a stale price.
        // 25% deviation guard — generous enough that ordinary volatility never trips it.
        oracle.configureFeed(BTC, false, 60, 2_500);
        oracle.configureFeed(ETH, false, 60, 2_500);
        oracle.configureFeed(SOL, false, 60, 2_500);
        oracle.setPythFeed(BTC, 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43);
        oracle.setPythFeed(ETH, 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace);
        oracle.setPythFeed(SOL, 0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d);

        // ── venue ─────────────────────────────────────────────────────────────────
        MiniPerp venue = new MiniPerp(deployer, address(assetToken), address(oracle));

        //           id   initMgn  maintMgn  takerFee  spread  impactDepth      minSize  fundRate  interval
        venue.listMarket(BTC, 1_500, 750, 690, 2, 2_000_000 * ONE, 1e14, 20, 2_580);
        venue.listMarket(ETH, 1_200, 600, 690, 2, 1_000_000 * ONE, 1e15, 20, 2_580);
        venue.listMarket(SOL, 1_000, 500, 690, 4, 500_000 * ONE, 1e16, 20, 2_580);

        // ── mandate system ────────────────────────────────────────────────────────
        MandateAccount accountImpl = new MandateAccount();
        MandateRegistry registry = new MandateRegistry(deployer, address(venue), address(accountImpl));
        CapitalPool pool = new CapitalPool(deployer, address(assetToken), "Mandate Pool Share", "mPOOL");

        registry.setPool(address(pool));
        pool.setRegistry(address(registry));
        venue.setFlattener(address(registry), true);
        registry.setIssuer(keeper, true);

        // ── seed ──────────────────────────────────────────────────────────────────
        assetToken.mint(deployer, VENUE_RESERVE + POOL_SEED);

        assetToken.approve(address(venue), VENUE_RESERVE);
        venue.fundReserve(VENUE_RESERVE);

        assetToken.approve(address(pool), POOL_SEED);
        pool.deposit(POOL_SEED, deployer);

        vm.stopBroadcast();

        // ── report ────────────────────────────────────────────────────────────────
        console2.log("");
        console2.log("=== Mandate deployed ===");
        console2.log("POOL_ASSET_ADDRESS          =", address(assetToken));
        console2.log("ORACLE_ADDRESS              =", address(oracle));
        console2.log("MINI_PERP_ADDRESS           =", address(venue));
        console2.log("MANDATE_ACCOUNT_IMPL_ADDRESS=", address(accountImpl));
        console2.log("MANDATE_REGISTRY_ADDRESS    =", address(registry));
        console2.log("CAPITAL_POOL_ADDRESS        =", address(pool));
        console2.log("");
        console2.log("Next: push a first price, then run `make seed`.");

        d = Deployed({
            asset: address(assetToken),
            oracle: address(oracle),
            venue: address(venue),
            accountImpl: address(accountImpl),
            registry: address(registry),
            pool: address(pool),
            deployer: deployer,
            keeper: keeper
        });
        _writeDeploymentFile();
    }

    /// @dev Writes DEPLOYMENT.md so a judge has the addresses without scrolling back through
    ///      forge output, and so the repo carries a record of what is actually live.
    function _writeDeploymentFile() internal {
        string memory rows = string.concat(
            _row("CapitalPool", d.pool),
            _row("MandateRegistry", d.registry),
            _row("MandateAccount impl", d.accountImpl),
            _row("MiniPerp", d.venue),
            _row("PriceOracle", d.oracle),
            _row("Asset (mUSD)", d.asset)
        );

        string memory env = string.concat(
            "POOL_ASSET_ADDRESS=", vm.toString(d.asset), "\n",
            "ORACLE_ADDRESS=", vm.toString(d.oracle), "\n",
            "MINI_PERP_ADDRESS=", vm.toString(d.venue), "\n",
            "MANDATE_ACCOUNT_IMPL_ADDRESS=", vm.toString(d.accountImpl), "\n",
            "MANDATE_REGISTRY_ADDRESS=", vm.toString(d.registry), "\n",
            "CAPITAL_POOL_ADDRESS=", vm.toString(d.pool), "\n",
            "INDEXER_START_BLOCK=", vm.toString(block.number), "\n"
        );

        string memory out = string.concat(
            "# Mandate - live deployment\n\n",
            "Monad testnet, chain ", vm.toString(block.chainid),
            ". Deployed at block ", vm.toString(block.number), ".\n\n",
            "| Contract | Address |\n|---|---|\n", rows, "\n",
            "Deployer `", vm.toString(d.deployer), "` - keeper `", vm.toString(d.keeper), "`\n\n",
            "## .env\n\n```\n", env, "```\n\n",
            "See [DEPLOY.md](DEPLOY.md) for what to do with these.\n"
        );

        vm.writeFile("../DEPLOYMENT.md", out);
    }

    function _row(string memory name, address a) internal pure returns (string memory) {
        return string.concat(
            "| ", name, " | [`", vm.toString(a),
            "`](https://testnet.monadscan.com/address/", vm.toString(a), ") |\n"
        );
    }
}

/**
 * Drives a mandate through a realistic price path into a breach, printing the risk state at
 * every step. Unlike scripts/demo.ts — which is the 90-second money shot — this is the slow
 * version: it walks a random-walk price path so you can watch the floor bind under something
 * that looks like a market rather than a staged three-step drop.
 *
 * Run: npm run keeper:simulate
 *
 * Requires the deployer key, because it forces oracle prices. On a real deployment the keeper
 * relays Perpl's live prices instead and nobody can push a price at all.
 */

import {createPublicClient, createWalletClient, http, type Address} from "viem";
import {privateKeyToAccount, generatePrivateKey} from "viem/accounts";

import {cfg, monadTestnet} from "./config.js";
import {registryAbi, oracleAbi} from "./abi.js";
import {log, usd} from "./log.js";

const BTC = 16;
const ALLOCATION = 100_000n * 1_000_000n;

const transport = http(cfg.rpcUrl, {retryCount: 3, timeout: 20_000});
const publicClient = createPublicClient({chain: monadTestnet, transport});

const ownerKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
if (!ownerKey) throw new Error("PRIVATE_KEY is required to force prices in a simulation");
const owner = createWalletClient({account: privateKeyToAccount(ownerKey), chain: monadTestnet, transport});

const forceAbi = [
  {
    type: "function",
    name: "forcePrice",
    inputs: [
      {name: "marketId", type: "uint16"},
      {name: "newPrice", type: "uint256"},
      {name: "publishedAt", type: "uint64"},
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const accountAbi = [
  {
    type: "function",
    name: "openPosition",
    inputs: [
      {name: "marketId", type: "uint16"},
      {name: "isLong", type: "bool"},
      {name: "size", type: "uint256"},
      {name: "limitPrice", type: "uint256"},
    ],
    outputs: [{type: "uint256"}],
    stateMutability: "nonpayable",
  },
] as const;

/** Prices must never be dated ahead of the chain's own clock. */
async function chainNow(): Promise<bigint> {
  return (await publicClient.getBlock({blockTag: "latest"})).timestamp;
}

async function setPrice(price: bigint) {
  const hash = await owner.writeContract({
    address: cfg.oracle, abi: forceAbi, functionName: "forcePrice",
    args: [BTC, price, await chainNow()],
  });
  await publicClient.waitForTransactionReceipt({hash});
}

async function main() {
  log.banner("Mandate — breach simulation");

  const traderKey = generatePrivateKey();
  const traderAccount = privateKeyToAccount(traderKey);
  const trader = createWalletClient({account: traderAccount, chain: monadTestnet, transport});

  const fund = await owner.sendTransaction({to: traderAccount.address, value: 10n ** 17n});
  await publicClient.waitForTransactionReceipt({hash: fund});

  // ── issue ──────────────────────────────────────────────────────────────────
  const expiry = (await chainNow()) + 30n * 24n * 3600n;
  const issueHash = await owner.writeContract({
    address: cfg.registry, abi: registryAbi, functionName: "issue",
    args: [
      traderAccount.address,
      {
        allocation: ALLOCATION,
        maxDrawdownBps: 1_000,
        dailyLossBps: 500,
        profitSplitBps: 8_000,
        maxPositionBps: 30_000,
        expiry,
        resetHourUtc: 0,
      },
    ],
  });
  await publicClient.waitForTransactionReceipt({hash: issueHash});

  const active = (await publicClient.readContract({
    address: cfg.registry, abi: registryAbi, functionName: "activeMandates",
  })) as readonly bigint[];
  const mandateId = active[active.length - 1]!;
  const state = (await publicClient.readContract({
    address: cfg.registry, abi: registryAbi, functionName: "stateOf", args: [mandateId],
  })) as {account: Address};

  log.ok(`mandate #${mandateId} issued`, {allocation: usd(ALLOCATION), account: state.account});

  // ── open ───────────────────────────────────────────────────────────────────
  const [startPrice] = (await publicClient.readContract({
    address: cfg.oracle, abi: oracleAbi, functionName: "price", args: [BTC],
  })) as readonly [bigint, bigint];

  // Restamp the feed before trading. Every trading path calls priceNoOlderThan, so a feed
  // that went stale while the keeper was down blocks the simulation with a StalePrice revert
  // that looks like a bug and is not one.
  await setPrice(startPrice);

  const openHash = await trader.writeContract({
    address: state.account, abi: accountAbi, functionName: "openPosition",
    args: [BTC, true, 2n * 10n ** 18n, 0n],
  });
  await publicClient.waitForTransactionReceipt({hash: openHash});
  log.ok("opened long 2 BTC", {price: usd(startPrice, 8)});

  // ── random walk, marking every step ────────────────────────────────────────
  // A genuine random walk with a negative drift, sized so it reliably reaches the floor
  // within the step budget. With 2 BTC against a 100k allocation the notional is ~1.5x, so a
  // ~3.4% adverse price move is a 5% equity move — exactly the daily loss limit. A drift of
  // -10bp per step over 60 steps clears that with room for the walk to wander on the way,
  // which is the point: the floor should bind under something that looks like a market, not
  // a staircase.
  let price = startPrice;
  for (let step = 1; step <= 60; step++) {
    const shock = (Math.random() - 0.62) * 0.008;
    price = (price * BigInt(Math.round((1 + shock) * 1_000_000))) / 1_000_000n;
    await setPrice(price);

    const {result} = await publicClient.simulateContract({
      account: owner.account,
      address: cfg.registry, abi: registryAbi, functionName: "markAndEnforce", args: [mandateId],
    });
    const hash = await owner.writeContract({
      address: cfg.registry, abi: registryAbi, functionName: "markAndEnforce", args: [mandateId],
    });
    const receipt = await publicClient.waitForTransactionReceipt({hash});

    const after = (await publicClient.readContract({
      address: cfg.registry, abi: registryAbi, functionName: "stateOf", args: [mandateId],
    })) as {status: number; breachKind: number; lastMarkedEquity: bigint};

    if (result || after.status !== 1) {
      const kinds = ["None", "TrailingDrawdown", "DailyLoss", "Expiry"];
      log.breach(`mandate #${mandateId} enforced at step ${step}`, {
        reason: kinds[after.breachKind] ?? "?",
        equity: usd(after.lastMarkedEquity),
        price: usd(price, 8),
        gas: receipt.gasUsed,
        tx: hash,
      });
      log.banner("simulation complete");
      return;
    }

    const [room, roomBps] = (await publicClient.readContract({
      address: cfg.registry, abi: registryAbi, functionName: "headroom", args: [mandateId],
    })) as readonly [bigint, bigint];

    log.info(`step ${String(step).padStart(2)}`, {
      price: usd(price, 8),
      equity: usd(after.lastMarkedEquity),
      headroom: `${usd(room)} (${Number(roomBps) / 100}%)`,
    });
  }

  log.warn("60 steps without a breach — the walk stayed inside the floor this run");
}

main().catch((e) => {
  log.error("simulation failed", {err: String(e).slice(0, 300)});
  process.exit(1);
});

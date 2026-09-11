/**
 * Mandate risk keeper.
 *
 * Every block:
 *   1. relay Perpl's live oracle prices onchain
 *   2. read the registry's list of Active mandates
 *   3. mark them all in one batched transaction, enforcing any that breached
 *   4. record gas so the economic argument is measured rather than asserted
 *
 * The keeper is a CONVENIENCE, NOT A TRUST ASSUMPTION. `markAndEnforce` on the registry is
 * permissionless — any LP, any observer, any competing trader can call it. If this process
 * dies, the rules still work. That is the property that separates Mandate from a prop firm's
 * private risk server, and it is why this file is allowed to be ordinary software.
 */

import {createPublicClient, createWalletClient, http, formatEther, type Address} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {cfg, monadTestnet} from "./config.js";
import {registryAbi, oracleAbi, poolAbi} from "./abi.js";
import {fetchPerplPrices, type MarketPrice} from "./perpl.js";
import {MarkStore} from "./store.js";
import {log, usd} from "./log.js";

const account = privateKeyToAccount(cfg.privateKey);
const transport = http(cfg.rpcUrl, {retryCount: 5, retryDelay: 250, timeout: 15_000});
const publicClient = createPublicClient({chain: monadTestnet, transport});
const walletClient = createWalletClient({account, chain: monadTestnet, transport});

const store = new MarkStore(cfg.storePath);

/** Last price pushed per market, so a flat market does not cost a transaction every block. */
const lastPushed = new Map<number, {onchain: bigint; at: number}>();

let consecutiveFailures = 0;
let running = true;

/** Split an array into chunks of at most `size`. */
function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * Decide which prices are worth a transaction.
 *
 * Pushing every market every block would be correct and wasteful. A price is pushed when it
 * has moved more than `minPriceMoveBps`, or when the last push is old enough that the onchain
 * feed is drifting towards its staleness bound. The second condition matters more than the
 * first: a stale feed halts trading and blocks enforcement, so the keeper must refresh a flat
 * market even when there is nothing to say.
 */
function pricesWorthPushing(prices: MarketPrice[]): MarketPrice[] {
  const now = Date.now();
  return prices.filter((p) => {
    const prev = lastPushed.get(p.id);
    if (!prev) return true;
    if (now - prev.at >= cfg.maxPriceAgeMs) return true;
    if (prev.onchain === 0n) return true;
    const diff = p.onchain > prev.onchain ? p.onchain - prev.onchain : prev.onchain - p.onchain;
    return (diff * 10_000n) / prev.onchain >= BigInt(cfg.minPriceMoveBps);
  });
}

async function pushPrices(prices: MarketPrice[], chainTime: bigint): Promise<void> {
  const due = pricesWorthPushing(prices);
  if (due.length === 0) return;

  // Clamp to the chain's own clock. PriceOracle rejects a publishedAt in the future, and the
  // node's timestamp can sit behind wall clock (always on a fork, occasionally on a live
  // node under load). Sending Date.now() unclamped makes the push revert for a reason that
  // has nothing to do with the price.
  const publishedAt = Math.min(
    Number(chainTime),
    Math.floor(Date.now() / 1000),
    Math.max(...due.map((p) => p.publishedAt)),
  );

  const hash = await walletClient.writeContract({
    address: cfg.oracle,
    abi: oracleAbi,
    functionName: "pushPrices",
    args: [due.map((p) => p.id), due.map((p) => p.onchain), BigInt(publishedAt)],
  });
  await publicClient.waitForTransactionReceipt({hash, timeout: 30_000});

  const at = Date.now();
  for (const p of due) lastPushed.set(p.id, {onchain: p.onchain, at});
}

/**
 * Mark every Active mandate and enforce any breaches.
 *
 * Batched deliberately: this is where the Monad argument lives. A per-block risk loop over
 * hundreds of accounts is only economically viable if one mark costs a fraction of a cent.
 */
async function markAll(
  blockNumber: bigint,
  prices: MarketPrice[],
  only?: readonly bigint[],
): Promise<void> {
  const active =
    only ??
    ((await publicClient.readContract({
      address: cfg.registry,
      abi: registryAbi,
      functionName: "activeMandates",
    })) as readonly bigint[]);

  if (active.length === 0) return;

  const priceMap = Object.fromEntries(prices.map((p) => [p.symbol, p.usd]));

  for (const batch of chunk(active, cfg.maxBatch)) {
    try {
      const {request, result} = await publicClient.simulateContract({
        account,
        address: cfg.registry,
        abi: registryAbi,
        functionName: "markAndEnforceBatch",
        args: [batch as readonly bigint[]],
      });

      const hash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({hash, timeout: 30_000});

      const breaches = Number(result ?? 0n);
      const costWei = receipt.gasUsed * receipt.effectiveGasPrice;
      const costMon = Number(formatEther(costWei));

      store.record({
        ts: Date.now(),
        blockNumber: blockNumber.toString(),
        mandateIds: batch.map(String),
        breaches,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice.toString(),
        costMon,
        txHash: hash,
        prices: priceMap,
      });

      if (breaches > 0) {
        log.breach(`enforced ${breaches} breach${breaches === 1 ? "" : "es"}`, {
          block: blockNumber,
          tx: hash,
          gas: receipt.gasUsed,
        });
        await reportBreaches(batch);
      } else {
        log.ok("marked", {
          block: blockNumber,
          mandates: batch.length,
          gas: receipt.gasUsed,
          mon: costMon.toFixed(6),
        });
      }
    } catch (err) {
      // One failing batch must never stop the loop. The next block tries again, and in the
      // meantime anyone else can enforce, because the function is permissionless.
      log.error("batch failed", {block: blockNumber, size: batch.length, err: String(err).slice(0, 160)});
    }
  }
}

/** After a breach, say which mandates ended and how. */
async function reportBreaches(batch: readonly bigint[]): Promise<void> {
  for (const id of batch) {
    try {
      const state = (await publicClient.readContract({
        address: cfg.registry,
        abi: registryAbi,
        functionName: "stateOf",
        args: [id],
      })) as {status: number; breachKind: number; lastMarkedEquity: bigint; trader: Address};

      if (state.status === 1) continue; // still Active
      const kinds = ["None", "TrailingDrawdown", "DailyLoss", "Expiry"];
      const statuses = ["None", "Active", "Breached", "Expired", "Closed"];
      log.breach(`mandate #${id} -> ${statuses[state.status] ?? "?"}`, {
        reason: kinds[state.breachKind] ?? "?",
        equity: usd(state.lastMarkedEquity),
        trader: state.trader,
      });
    } catch {
      /* reporting is best-effort; never let it break the loop */
    }
  }
}

async function summary(): Promise<void> {
  const t = store.totals;
  if (t.marks === 0) return;
  log.info("keeper totals", {
    blocks: t.blocksObserved,
    txs: t.marks,
    mandateMarks: t.mandateMarks,
    breaches: t.breaches,
    gas: t.gasUsed,
    mon: t.costMon.toFixed(6),
    perMark: store.costPerMandateMark.toExponential(3),
  });
}

/** Which active mandates are at or under their floor right now. Reads only. */
async function findBreaches(active: readonly bigint[]): Promise<bigint[]> {
  const out: bigint[] = [];
  for (const id of active) {
    try {
      const [[floor], live] = await Promise.all([
        publicClient.readContract({
          address: cfg.registry, abi: registryAbi, functionName: "floorOf", args: [id],
        }) as Promise<readonly [bigint, bigint]>,
        publicClient.readContract({
          address: cfg.registry, abi: registryAbi, functionName: "liveEquity", args: [id],
        }) as Promise<bigint>,
      ]);
      // Under, or within nearFloorBps of it: mark now rather than wait for the schedule.
      const threshold = floor + (floor * BigInt(cfg.nearFloorBps)) / 10_000n;
      if (live <= threshold) out.push(id);
    } catch {
      /* a mandate that cannot be read is not evidence of anything */
    }
  }
  return out;
}

async function hasGas(): Promise<boolean> {
  const bal = await publicClient.getBalance({address: account.address});
  const mon = Number(formatEther(bal));
  if (mon < cfg.minBalanceMon) {
    log.warn("keeper wallet is nearly empty — not sending transactions", {
      mon: mon.toFixed(4),
      floor: cfg.minBalanceMon,
      address: account.address,
    });
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  log.banner("Mandate risk keeper");
  log.info("config", {
    chain: monadTestnet.id,
    keeper: account.address,
    registry: cfg.registry,
    mode: cfg.mode,
    batch: cfg.maxBatch,
  });

  const balance = await publicClient.getBalance({address: account.address});
  log.info("keeper balance", {mon: formatEther(balance)});
  if (balance === 0n) {
    log.warn("keeper has no MON — it cannot submit transactions. Fund it from the faucet.");
  }

  try {
    const pool = await publicClient.readContract({
      address: cfg.pool,
      abi: poolAbi,
      functionName: "totalAssets",
    });
    log.info("pool", {totalAssets: usd(pool as bigint)});
  } catch {
    log.warn("could not read the pool — check CAPITAL_POOL_ADDRESS");
  }

  log.info("enforce() is permissionless: this keeper is a convenience, not a trust assumption");

  if (cfg.mode === "block") return blockLoop();
  return demandLoop();
}

/** Fork mode: mark everything, every block. Gas is free. */
async function blockLoop(): Promise<void> {
  let lastBlock = 0n;
  while (running) {
    try {
      const block = await publicClient.getBlock({blockTag: "latest"});
      const blockNumber = block.number;
      if (blockNumber === lastBlock) {
        await new Promise((r) => setTimeout(r, cfg.pollMs));
        continue;
      }
      lastBlock = blockNumber;
      store.observeBlock();

      const snapshot = await fetchPerplPrices();
      await pushPrices(snapshot.prices, block.timestamp);
      await markAll(blockNumber, snapshot.prices);

      consecutiveFailures = 0;
      if (store.totals.blocksObserved % 200 === 0) await summary();
    } catch (err) {
      await backoff(err);
    }
  }
}

/**
 * Live mode: watch for free, transact only when it matters.
 *
 *   every watchIntervalMs   read live equity vs floor for every active mandate (free)
 *                           -> mark any at/under/near its floor immediately
 *                           -> refresh prices if moved > minPriceMoveBps or getting stale
 *   every routineMarkMs     mark everything, so lastMarkedEquity and day rollovers keep up
 */
async function demandLoop(): Promise<void> {
  let lastRoutineMark = 0;
  log.info("demand mode", {
    watchEvery: `${cfg.watchIntervalMs / 1000}s`,
    routineMarkEvery: `${cfg.routineMarkIntervalMs / 60_000}m`,
    priceRefreshEvery: `${cfg.maxPriceAgeMs / 60_000}m or ${cfg.minPriceMoveBps}bp move`,
  });

  while (running) {
    try {
      const block = await publicClient.getBlock({blockTag: "latest"});
      store.observeBlock();

      const snapshot = await fetchPerplPrices();

      const active = (await publicClient.readContract({
        address: cfg.registry, abi: registryAbi, functionName: "activeMandates",
      })) as readonly bigint[];

      if (await hasGas()) {
        // Prices first: a mark against a stale feed reverts, and enforcement must never be
        // blocked by a feed we let go stale ourselves.
        await pushPrices(snapshot.prices, block.timestamp);

        const urgent = await findBreaches(active);
        const routineDue = Date.now() - lastRoutineMark >= cfg.routineMarkIntervalMs;

        if (urgent.length > 0) {
          log.warn("mandate(s) at or near the floor — marking now", {ids: urgent.join(",")});
          await markAll(block.number, snapshot.prices, urgent);
        } else if (routineDue && active.length > 0) {
          log.info("routine mark", {mandates: active.length});
          await markAll(block.number, snapshot.prices);
          lastRoutineMark = Date.now();
        }
        if (urgent.length > 0 && routineDue) lastRoutineMark = Date.now();
      }

      consecutiveFailures = 0;
      if (store.totals.blocksObserved % 50 === 0) await summary();
    } catch (err) {
      await backoff(err);
    }
    await new Promise((r) => setTimeout(r, cfg.watchIntervalMs));
  }
}

async function backoff(err: unknown): Promise<void> {
  consecutiveFailures++;
  const ms = Math.min(1_000 * 2 ** Math.min(consecutiveFailures, 5), 30_000);
  log.error("loop error, backing off", {ms, failures: consecutiveFailures, err: String(err).slice(0, 160)});
  await new Promise((r) => setTimeout(r, ms));
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    running = false;
    log.banner("shutting down");
    store.flush();
    void summary().then(() => process.exit(0));
  });
}

main().catch((err) => {
  log.error("keeper crashed", {err: String(err)});
  store.flush();
  process.exit(1);
});

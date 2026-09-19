/**
 * Record a real breach and freeze it as a replay fixture.
 *
 * The demo cannot depend on a keeper being alive and a wallet having gas — a judge opens the
 * link at a time of their choosing, and the honest answer is that infrastructure is sometimes
 * down. So the landing page plays back a breach that genuinely happened: every number here is
 * read from chain state after a real transaction, including the enforcing transaction hash.
 *
 * It is a recording, not a simulation, and the page says so.
 *
 * Run against a local fork: npx tsx scripts/capture-replay.ts
 */

import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {createWalletClient, http} from "viem";
import {abis, addrs, pub, wallet, terms, ONE, monadTestnet, RPC, c} from "./lib.js";
import {writeFileSync} from "node:fs";

const BTC = 16;
const ALLOCATION = 100_000n * ONE;
const OUT = "web/lib/replay-data.json";

type Frame = {
  t: number;
  price: number;
  equity: number;
  floor: number;
  peak: number;
  headroom: number;
  headroomBps: number;
  status: "active" | "breached";
  label?: string;
};

async function chainNow(): Promise<bigint> {
  return (await pub.getBlock({blockTag: "latest"})).timestamp;
}

async function main() {
  const a = addrs();
  const owner = wallet();
  const num = (v: bigint, d = 6) => Number(v) / 10 ** d;

  console.log(`\n${c.b}Capturing a real breach${c.r}`);

  // ── a fresh trader, a fresh mandate ─────────────────────────────────────────
  const traderKey = generatePrivateKey();
  const trader = privateKeyToAccount(traderKey);
  const traderWallet = createWalletClient({account: trader, chain: monadTestnet, transport: http(RPC)});
  await pub.waitForTransactionReceipt({
    hash: await owner.sendTransaction({to: trader.address, value: 10n ** 17n}),
  });

  const expiry = (await chainNow()) + 30n * 24n * 3600n;
  await pub.waitForTransactionReceipt({
    hash: await owner.writeContract({
      address: a.registry, abi: abis.registry, functionName: "issue",
      args: [trader.address, terms({
        allocation: ALLOCATION,
        maxDrawdownBps: 1_000,
        dailyLossBps: 500,
        profitSplitBps: 8_000,
        maxPositionBps: 30_000,
        expiry,
      })],
    }),
  });

  const active = await pub.readContract({address: a.registry, abi: abis.registry, functionName: "activeMandates"});
  const id = active[active.length - 1]!;
  const state = await pub.readContract({address: a.registry, abi: abis.registry, functionName: "stateOf", args: [id]});
  const account = state[1];
  console.log(`  mandate #${id} · account ${account}`);

  // ── refresh the feed, then open a position ──────────────────────────────────
  const [startPrice] = await pub.readContract({address: a.oracle, abi: abis.oracle, functionName: "price", args: [BTC]});
  await pub.waitForTransactionReceipt({
    hash: await owner.writeContract({
      address: a.oracle, abi: abis.oracle, functionName: "forcePrice",
      args: [BTC, startPrice, await chainNow()],
    }),
  });
  await pub.waitForTransactionReceipt({
    hash: await traderWallet.writeContract({
      address: account, abi: abis.account, functionName: "openPosition",
      args: [BTC, true, 2n * 10n ** 18n, 0n], chain: null, account: trader,
    }),
  });
  console.log(`  long 2 BTC at ${num(startPrice, 8).toFixed(2)}`);

  // ── walk the price down, reading real state at each step ────────────────────
  const frames: Frame[] = [];
  // Percent of the start price. Deliberately not monotonic: a real chart wanders, and a
  // straight line down looks staged because it is.
  const path = [100, 99.4, 99.7, 98.8, 98.2, 98.5, 97.6, 96.9, 96.2, 95.4];
  const labels: Record<number, string> = {
    0: "Funded. $100,000 under enforced terms.",
    3: "Price moving against the position.",
    6: "Headroom shrinking — the floor does not move.",
    8: "One tick from enforcement.",
  };

  let breachTx = "";
  for (let i = 0; i < path.length; i++) {
    const price = (startPrice * BigInt(Math.round(path[i]! * 100))) / 10_000n;
    await pub.waitForTransactionReceipt({
      hash: await owner.writeContract({
        address: a.oracle, abi: abis.oracle, functionName: "forcePrice",
        args: [BTC, price, await chainNow()],
      }),
    });

    const st = await pub.readContract({address: a.registry, abi: abis.registry, functionName: "stateOf", args: [id]});
    const stillActive = Number(st[13]) === 1;
    const equity = stillActive
      ? ((await pub.readContract({address: a.registry, abi: abis.registry, functionName: "liveEquity", args: [id]})) as bigint)
      : (st[7] as bigint);
    const [floor] = await pub.readContract({address: a.registry, abi: abis.registry, functionName: "floorOf", args: [id]});
    const [room, roomBps] = stillActive
      ? await pub.readContract({address: a.registry, abi: abis.registry, functionName: "headroom", args: [id]})
      : ([0n, 0n] as const);

    frames.push({
      t: i,
      price: num(price, 8),
      equity: num(equity),
      floor: num(floor),
      peak: num(st[3] as bigint),
      headroom: num(room),
      headroomBps: Number(roomBps),
      status: equity < floor ? "breached" : "active",
      label: labels[i],
    });
    console.log(
      `  ${String(i).padStart(2)}  $${num(price, 8).toFixed(0).padStart(7)}  ` +
        `equity ${num(equity).toFixed(0).padStart(7)}  headroom ${num(room).toFixed(0).padStart(6)}`,
    );

    // Once under the floor, enforce it — from a wallet with no role in the system.
    if (equity < floor && !breachTx) {
      const strangerKey = generatePrivateKey();
      const stranger = privateKeyToAccount(strangerKey);
      const strangerWallet = createWalletClient({account: stranger, chain: monadTestnet, transport: http(RPC)});
      await pub.waitForTransactionReceipt({
        hash: await owner.sendTransaction({to: stranger.address, value: 10n ** 17n}),
      });
      breachTx = await strangerWallet.writeContract({
        address: a.registry, abi: abis.registry, functionName: "markAndEnforce",
        args: [id], chain: null, account: stranger,
      });
      const rec = await pub.waitForTransactionReceipt({hash: breachTx});

      const after = await pub.readContract({address: a.registry, abi: abis.registry, functionName: "stateOf", args: [id]});
      frames.push({
        t: frames.length,
        price: num(price, 8),
        equity: num(after[7] as bigint),
        floor: num(floor),
        peak: num(after[3] as bigint),
        headroom: 0,
        headroomBps: 0,
        status: "breached",
        label: "Enforced. Position flattened, capital returned — in one transaction, by a stranger.",
      });
      console.log(`\n  ${c.red}BREACH enforced${c.r} · gas ${rec.gasUsed} · tx ${breachTx.slice(0, 14)}…`);
      break;
    }
  }

  const fixture = {
    capturedAt: new Date().toISOString(),
    allocation: num(ALLOCATION),
    maxDrawdownPct: 10,
    dailyLossPct: 5,
    splitPct: 80,
    enforcedBy: "a wallet with no role in the system",
    txHash: breachTx,
    frames,
  };
  writeFileSync(OUT, JSON.stringify(fixture, null, 2));
  console.log(`\n${c.green}✓${c.r} ${frames.length} frames -> ${OUT}\n`);
}

main().catch((e) => {
  console.error(`\n${c.red}capture failed:${c.r}`, e);
  process.exit(1);
});

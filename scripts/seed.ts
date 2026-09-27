/**
 * Seed a freshly deployed system so the dashboards are not empty and a judge can see the
 * product working within a minute of opening it.
 *
 * Creates four mandates in deliberately different states:
 *   1. healthy      — comfortable headroom, in profit
 *   2. near-floor   — a few hundred dollars from being enforced out
 *   3. breached     — already enforced, showing the flatten-and-settle path
 *   4. flat         — issued, untraded, showing a mandate at rest
 *
 * Run: npm run seed
 */

import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {createWalletClient, http} from "viem";
import {
  abis, addrs, pub, wallet, terms, ONE, usd, px, c, STATUS,
  monadTestnet, RPC, sleep,
} from "./lib.js";

const BTC = 16;

type Seeded = {label: string; id: bigint; account: `0x${string}`; pk: `0x${string}`};

async function chainNow(): Promise<bigint> {
  const b = await pub.getBlock({blockTag: "latest"});
  return b.timestamp;
}

/** Prices must never be dated ahead of the chain's own clock. */
async function setPrice(owner: ReturnType<typeof wallet>, oracle: `0x${string}`, price: bigint) {
  const ts = await chainNow();
  const hash = await owner.writeContract({
    address: oracle, abi: abis.oracle, functionName: "forcePrice", args: [BTC, price, ts],
  });
  await pub.waitForTransactionReceipt({hash});
}

async function main() {
  const a = addrs();
  const owner = wallet();

  console.log(`\n${c.b}Seeding Mandate${c.r}\n${c.d}${"─".repeat(60)}${c.r}`);

  const [startPrice] = await pub.readContract({
    address: a.oracle, abi: abis.oracle, functionName: "price", args: [BTC],
  });
  console.log(`BTC ${px(startPrice)}  ${c.d}(relayed from Perpl)${c.r}`);

  // Refresh the feed before doing anything. Every trading path calls priceNoOlderThan, so a
  // feed that went stale while the keeper was down blocks the whole seed with a StalePrice
  // revert that looks like a bug and is not one.
  await setPrice(owner, a.oracle, startPrice);
  console.log(`${c.d}feed refreshed${c.r}\n`);

  const expiry = (await chainNow()) + 30n * 24n * 3600n;
  const seeded: Seeded[] = [];

  // ── issue four mandates to four fresh traders ───────────────────────────────
  for (const label of ["healthy", "near-floor", "breached", "flat"]) {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);

    const fund = await owner.sendTransaction({to: acct.address, value: 10n ** 17n});
    await pub.waitForTransactionReceipt({hash: fund});

    const hash = await owner.writeContract({
      address: a.registry, abi: abis.registry, functionName: "issue",
      args: [
        acct.address,
        terms({
          allocation: 100_000n * ONE,
          maxDrawdownBps: 1_000,
          dailyLossBps: 500,
          profitSplitBps: 8_000,
          maxPositionBps: 30_000,
          expiry,
          // A real consistency rule, so the payout panel shows the arithmetic rather than
          // "no conditions". 35% is the 2-Step On-Demand threshold. The risk terms are left
          // alone deliberately — the four seeded states depend on them.
          maxConsistencyBps: 3_500,
        }),
      ],
    });
    await pub.waitForTransactionReceipt({hash});

    const active = await pub.readContract({
      address: a.registry, abi: abis.registry, functionName: "activeMandates",
    });
    const id = active[active.length - 1]!;
    const st = await pub.readContract({
      address: a.registry, abi: abis.registry, functionName: "stateOf", args: [id],
    });
    seeded.push({label, id, account: st[1], pk});
    console.log(`  ${c.green}✓${c.r} #${id} ${label.padEnd(11)} ${st[1]}`);
  }

  // ── open positions ──────────────────────────────────────────────────────────
  //
  // Sizes and directions are chosen so that ONE monotonic downward price path lands each
  // mandate in a different state, with no manual intervention part-way through:
  //
  //   healthy     short 1 BTC — profits as the price falls
  //   near-floor  long  2 BTC — ends a few hundred dollars above its floor
  //   breached    long  3 BTC — crosses the floor on the way down and is enforced out
  //   flat        no position
  //
  // An earlier version closed a position mid-path to engineer the near-floor state, which
  // broke the moment that mandate breached first. Letting the sizes do the work is both
  // simpler and a more honest demonstration.
  console.log(`${c.b}Opening positions${c.r}`);

  // Sizes are expressed as a share of each mandate's headroom, not in BTC.
  //
  // They used to be fixed — 1, 2 and 3 BTC — which silently calibrated the whole scenario
  // to BTC at about $81k. The registry's pre-trade check refuses any open whose equity,
  // after a `preTradeBufferBps` (2%) adverse move, would sit under the floor; at $84.7k the
  // 3 BTC "breached" open projected to $94,919.57 against a $95,000 floor and reverted with
  // WouldBreachFloor, and the whole local stack stopped at step 4. Priced against headroom,
  // each outcome holds at any BTC level:
  //
  //   buffer   = preTradeBufferBps (2%)      path = the 2.5% walk-down below
  //   breached   0.90 · H / (buffer · P)  →  pre-trade uses 90% of H; the walk loses 1.125 H
  //   near-floor 0.85 · H / (path · P)    →  pre-trade uses 68% of H; ends 0.15 H above floor
  //   healthy    0.35 · H / (buffer · P)  →  short, so the walk-down only helps it
  const BUFFER = 200n; // bps — MandateRegistry.preTradeBufferBps
  const PATH = 250n; // bps — the 1000‰ → 975‰ walk below
  const sizeFor = (headroom: bigint, share: bigint, moveBps: bigint) =>
    // (H/1e6)·(share/100) / ((move/1e4)·(P/1e8)) · 1e18  =  H·share·1e22 / (move·P),
    // floored to 0.001 BTC. At $84.7k: breached 2.657, near-floor 2.008, healthy 1.033.
    (((headroom * share * 10n ** 22n) / (moveBps * startPrice)) / 10n ** 15n) * 10n ** 15n;

  const plan: Record<string, {share: bigint; move: bigint; isLong: boolean}> = {
    healthy: {share: 35n, move: BUFFER, isLong: false},
    "near-floor": {share: 85n, move: PATH, isLong: true},
    breached: {share: 90n, move: BUFFER, isLong: true},
  };

  for (const s of seeded) {
    const spec = plan[s.label];
    if (!spec) continue;
    const [headroom] = await pub.readContract({
      address: a.registry, abi: abis.registry, functionName: "headroom", args: [s.id],
    });
    const p = {size: sizeFor(headroom, spec.share, spec.move), isLong: spec.isLong};
    const w = createWalletClient({
      account: privateKeyToAccount(s.pk), chain: monadTestnet, transport: http(RPC),
    });
    const hash = await w.writeContract({
      address: s.account, abi: abis.account, functionName: "openPosition",
      args: [BTC, p.isLong, p.size, 0n],
    });
    await pub.waitForTransactionReceipt({hash});
    console.log(
      `  ${c.green}✓${c.r} #${s.id} ${s.label.padEnd(11)} ` +
      `${p.isLong ? "long " : "short"} ${Number(p.size) / 1e18} BTC`,
    );
  }

  // ── walk the price down, marking at every step ──────────────────────────────
  // Each mark writes an EquityMarked event, which is what the indexer turns into the equity
  // curve on the trader screen. A seeded system with no marks has an empty chart.
  console.log(`\n${c.b}Building history${c.r}`);
  for (const pct of [1000n, 995n, 990n, 985n, 980n, 975n]) {
    const price = (startPrice * pct) / 1000n;
    await setPrice(owner, a.oracle, price);
    const breaches = await markAll(a.registry);
    console.log(
      `  ${c.d}BTC ${px(price)} — marked${c.r}` +
      (breaches > 0 ? `  ${c.red}${breaches} enforced${c.r}` : ""),
    );
    await sleep(150);
  }

  // ── report ──────────────────────────────────────────────────────────────────
  console.log(`\n${c.b}Result${c.r}`);
  for (const s of seeded) {
    const st = await pub.readContract({
      address: a.registry, abi: abis.registry, functionName: "stateOf", args: [s.id],
    });
    const status = STATUS[Number(st[13])]!;
    let room = "—";
    if (status === "Active") {
      const [abs, bps] = await pub.readContract({
        address: a.registry, abi: abis.registry, functionName: "headroom", args: [s.id],
      });
      room = `${usd(abs)} (${Number(bps) / 100}%)`;
    }
    const colour = status === "Breached" ? c.red : status === "Active" ? c.green : c.yellow;
    console.log(
      `  #${String(s.id).padEnd(3)} ${s.label.padEnd(11)} ${colour}${status.padEnd(9)}${c.r}` +
      ` equity ${usd(st[7]).padStart(12)}  headroom ${room}`,
    );
  }

  const total = await pub.readContract({address: a.pool, abi: abis.pool, functionName: "totalAssets"});
  const idle = await pub.readContract({address: a.pool, abi: abis.pool, functionName: "idleAssets"});
  const pps = await pub.readContract({address: a.pool, abi: abis.pool, functionName: "pricePerShare"});
  console.log(
    `\n${c.b}Pool${c.r} TVL ${usd(total)} · idle ${usd(idle)} · share ${usd(pps)}\n`,
  );

  console.log(`${c.d}Trader keys for the seeded mandates (testnet only):${c.r}`);
  for (const s of seeded) console.log(`  #${s.id} ${s.label.padEnd(11)} ${s.pk}`);
  console.log("");
}

/** Mark every Active mandate. Returns how many this pass enforced out. */
async function markAll(registry: `0x${string}`): Promise<number> {
  const owner = wallet();
  const active = await pub.readContract({
    address: registry, abi: abis.registry, functionName: "activeMandates",
  });
  let breaches = 0;
  for (const id of active) {
    try {
      const {result} = await pub.simulateContract({
        account: owner.account,
        address: registry, abi: abis.registry, functionName: "markAndEnforce", args: [id],
      });
      const hash = await owner.writeContract({
        address: registry, abi: abis.registry, functionName: "markAndEnforce", args: [id],
      });
      await pub.waitForTransactionReceipt({hash});
      if (result) breaches++;
    } catch {
      /* a mandate that settled earlier in this pass is not an error */
    }
  }
  return breaches;
}

main().catch((e) => {
  console.error(`\n${c.red}seed failed:${c.r}`, e);
  process.exit(1);
});

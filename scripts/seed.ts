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
  const plan: Record<string, {size: bigint; isLong: boolean}> = {
    healthy: {size: 1n * 10n ** 18n, isLong: false},
    "near-floor": {size: 2n * 10n ** 18n, isLong: true},
    breached: {size: 3n * 10n ** 18n, isLong: true},
  };

  for (const s of seeded) {
    const p = plan[s.label];
    if (!p) continue;
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
    const status = STATUS[Number(st[8])]!;
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
      ` equity ${usd(st[5]).padStart(12)}  headroom ${room}`,
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

/**
 * Seed the underwriting book so the market has something in it.
 *
 * Posts a ladder of offers that demonstrates the thing the market exists to do: the terms
 * improve as the record required gets harder. A trader with nothing takes the 70/30; a
 * trader who has settled mandates cleanly is worth 92/8 to somebody.
 *
 * Run: npm run seed:market
 */

import {privateKeyToAccount, generatePrivateKey} from "viem/accounts";
import {createWalletClient, http} from "viem";
import {
  abis, addrs, pub, wallet, terms, criteria, ONE, usd, c, monadTestnet, RPC, DrawdownMode,
} from "./lib.js";

type Rung = {
  label: string;
  allocation: bigint;
  splitBps: number;
  ddBps: number;
  dailyBps: number;
  mode: number;
  consistencyBps: number;
  slots: number;
  req: Parameters<typeof criteria>[0];
  note: string;
};

/** The ladder. Harder record required, better terms offered. */
const LADDER: Rung[] = [
  {
    label: "Open to anyone",
    allocation: 25_000n * ONE,
    splitBps: 7_000,
    ddBps: 800,
    dailyBps: 400,
    mode: DrawdownMode.TrailingUntilBreakeven,
    consistencyBps: 3_500,
    slots: 20,
    req: {},
    note: "no record required — this is where you start",
  },
  {
    label: "One clean mandate",
    allocation: 50_000n * ONE,
    splitBps: 8_000,
    ddBps: 1_000,
    dailyBps: 500,
    mode: DrawdownMode.Static,
    consistencyBps: 3_500,
    slots: 10,
    req: {minMandatesSettled: 1, maxBreaches: 0},
    note: "settled once without breaching",
  },
  {
    label: "Proven",
    allocation: 100_000n * ONE,
    splitBps: 9_000,
    ddBps: 1_000,
    dailyBps: 500,
    mode: DrawdownMode.Static,
    consistencyBps: 2_000,
    slots: 5,
    req: {minMandatesSettled: 2, maxBreaches: 0, minProfitableExits: 1},
    note: "two settled, none breached, at least one in profit",
  },
  {
    label: "Prime",
    allocation: 250_000n * ONE,
    splitBps: 9_200,
    ddBps: 600,
    dailyBps: 300,
    mode: DrawdownMode.Static,
    consistencyBps: 1_500,
    slots: 2,
    req: {minMandatesSettled: 3, maxBreaches: 0, minProfitableExits: 2, maxConsistencyBps: 2_500},
    note: "a real track record, and profit spread across days",
  },
];

async function main() {
  const a = addrs();
  const owner = wallet();
  const now = (await pub.getBlock({blockTag: "latest"})).timestamp;

  console.log(`\n${c.b}Seeding the underwriting book${c.r}`);
  console.log(`${c.d}${"─".repeat(72)}${c.r}`);

  for (const rung of LADDER) {
    // Each rung is posted by its own LP, so the book looks like a market rather than one
    // desk pretending to be several.
    const lpKey = generatePrivateKey();
    const lp = privateKeyToAccount(lpKey);
    const lpWallet = createWalletClient({account: lp, chain: monadTestnet, transport: http(RPC)});

    const total = rung.allocation * BigInt(rung.slots);
    await pub.waitForTransactionReceipt({
      hash: await owner.sendTransaction({to: lp.address, value: 10n ** 17n}),
    });
    await pub.waitForTransactionReceipt({
      hash: await owner.writeContract({
        address: a.asset, abi: abis.erc20, functionName: "mint", args: [lp.address, total],
      }),
    });
    await pub.waitForTransactionReceipt({
      hash: await lpWallet.writeContract({
        address: a.asset, abi: abis.erc20, functionName: "approve", args: [a.book, total],
        chain: null, account: lp,
      }),
    });

    const hash = await lpWallet.writeContract({
      address: a.book, abi: abis.book, functionName: "postOffer",
      chain: null, account: lp,
      args: [
        terms({
          allocation: rung.allocation,
          maxDrawdownBps: rung.ddBps,
          dailyLossBps: rung.dailyBps,
          profitSplitBps: rung.splitBps,
          maxPositionBps: 30_000,
          expiry: now + 30n * 24n * 3600n,
          drawdownMode: rung.mode,
          maxConsistencyBps: rung.consistencyBps,
        }),
        criteria(rung.req),
        rung.slots,
      ],
    });
    await pub.waitForTransactionReceipt({hash});

    console.log(
      `  ${c.green}✓${c.r} ${rung.label.padEnd(18)} ` +
        `${usd(rung.allocation).padStart(12)} @ ${c.green}${rung.splitBps / 100}%${c.r}` +
        ` · ${rung.slots} slots  ${c.d}${rung.note}${c.r}`,
    );
  }

  const open = await pub.readContract({
    address: a.book, abi: abis.book, functionName: "openOffers",
  });
  console.log(`\n${c.b}${open.length} offers live on the book.${c.r}`);
  console.log(
    `${c.d}Terms improve as the record required gets harder. That is the market pricing\n` +
      `trader risk — nobody negotiated any of it.${c.r}\n`,
  );
}

main().catch((e) => {
  console.error(`\n${c.red}seed-market failed:${c.r}`, e);
  process.exit(1);
});

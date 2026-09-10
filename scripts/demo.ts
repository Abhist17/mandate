/**
 * The money shot, run live on Monad testnet, deterministically, in under 90 seconds.
 *
 *   healthy mandate -> adverse price move -> equity crosses the drawdown floor ->
 *   a stranger flattens the position and revokes the mandate in one transaction
 *
 * Run: npm run demo
 *
 * The enforcing call is deliberately made from a throwaway wallet that has no role in the
 * system — not the owner, not the issuer, not the keeper. That is the whole point:
 * `markAndEnforce` is permissionless, so the rules do not depend on us being willing to
 * apply them.
 */

import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {createWalletClient, http, parseEventLogs} from "viem";
import {
  abis, addrs, pub, wallet, terms, ONE, PRICE, usd, px, c, sleep,
  STATUS, BREACH, monadTestnet, RPC, env,
} from "./lib.js";

const BTC = 16;
const ALLOCATION = 100_000n * ONE;

const line = () => console.log(c.d + "─".repeat(74) + c.r);
const step = (n: number, s: string) => console.log(`\n${c.b}${n}. ${s}${c.r}`);
const tick = (s: string) => console.log(`   ${c.green}✓${c.r} ${s}`);
const note = (s: string) => console.log(`   ${c.d}${s}${c.r}`);

async function main() {
  const a = addrs();
  const owner = wallet();
  const explorer = process.env.MONAD_EXPLORER_URL ?? "https://testnet.monadscan.com";

  console.log(`\n${c.b}MANDATE — live breach enforcement${c.r}`);
  console.log(`${c.d}The rules are the contract.${c.r}`);
  line();

  // ── 1. issue ────────────────────────────────────────────────────────────────
  step(1, "Issue a mandate");
  const traderPk = generatePrivateKey();
  const traderAccount = privateKeyToAccount(traderPk);
  const traderWallet = createWalletClient({
    account: traderAccount,
    chain: monadTestnet,
    transport: http(RPC),
  });

  // Fund the demo trader with gas.
  const fundHash = await owner.sendTransaction({to: traderAccount.address, value: 10n ** 17n});
  await pub.waitForTransactionReceipt({hash: fundHash});

  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
  const issueHash = await owner.writeContract({
    address: a.registry,
    abi: abis.registry,
    functionName: "issue",
    args: [
      traderAccount.address,
      terms({
        allocation: ALLOCATION,
        maxDrawdownBps: 1_000, // 10% trailing
        dailyLossBps: 500, //  5% daily
        profitSplitBps: 8_000, // 80/20 to the trader
        maxPositionBps: 30_000, // 3x
        expiry,
      }),
    ],
  });
  const issueReceipt = await pub.waitForTransactionReceipt({hash: issueHash});

  const active = await pub.readContract({
    address: a.registry, abi: abis.registry, functionName: "activeMandates",
  });
  const mandateId = active[active.length - 1]!;
  const state = await pub.readContract({
    address: a.registry, abi: abis.registry, functionName: "stateOf", args: [mandateId],
  });
  const accountAddr = state[1];

  tick(`mandate #${mandateId} issued to ${traderAccount.address.slice(0, 10)}…`);
  note(`allocation ${usd(ALLOCATION)} · 10% trailing drawdown · 5% daily · 80/20 · 3x cap`);
  note(`account ${accountAddr}`);
  note(`tx ${explorer}/tx/${issueHash}`);

  // ── 2. trade ────────────────────────────────────────────────────────────────
  step(2, "Trader opens a position");
  const [startPrice] = await pub.readContract({
    address: a.oracle, abi: abis.oracle, functionName: "price", args: [BTC],
  });

  // Restamp the feed at the chain's own clock before trading.
  //
  // Every trading path calls priceNoOlderThan, so if the keeper is not running the feed
  // ages out and the demo dies on a StalePrice revert that looks like a bug in the
  // protocol and is not one. The demo has to stand alone — a judge runs `make demo`
  // without necessarily having a keeper up.
  {
    const now = (await pub.getBlock({blockTag: "latest"})).timestamp;
    const refresh = await owner.writeContract({
      address: a.oracle, abi: abis.oracle, functionName: "forcePrice",
      args: [BTC, startPrice, now],
    });
    await pub.waitForTransactionReceipt({hash: refresh});
  }

  const openHash = await traderWallet.writeContract({
    address: accountAddr, abi: abis.account, functionName: "openPosition",
    args: [BTC, true, 2n * 10n ** 18n, 0n],
  });
  await pub.waitForTransactionReceipt({hash: openHash});

  const notional = await pub.readContract({
    address: a.venue, abi: abis.venue, functionName: "totalNotional", args: [accountAddr],
  });
  tick(`long 2 BTC at ${px(startPrice)} — notional ${usd(notional)}`);
  note(`inside the 3x cap of ${usd(ALLOCATION * 3n)}`);

  // ── 3. watch the floor ──────────────────────────────────────────────────────
  step(3, "The floor the trader must stay above");
  const [floor] = await pub.readContract({
    address: a.registry, abi: abis.registry, functionName: "floorOf", args: [mandateId],
  });
  const [room, roomBps] = await pub.readContract({
    address: a.registry, abi: abis.registry, functionName: "headroom", args: [mandateId],
  });
  tick(`floor ${usd(floor)} · headroom ${usd(room)} (${Number(roomBps) / 100}%)`);
  note("the daily loss limit binds first, being tighter than the trailing drawdown");

  // ── 4. the move ─────────────────────────────────────────────────────────────
  step(4, "The market moves against them");
  const path = [98n, 96n, 94n]; // percent of the starting price
  for (const pct of path) {
    const next = (startPrice * pct) / 100n;
    const hash = await owner.writeContract({
      address: a.oracle, abi: abis.oracle, functionName: "forcePrice",
      args: [BTC, next, BigInt(Math.floor(Date.now() / 1000))],
    });
    await pub.waitForTransactionReceipt({hash});

    const equity = await pub.readContract({
      address: a.registry, abi: abis.registry, functionName: "liveEquity", args: [mandateId],
    });
    const [r] = await pub.readContract({
      address: a.registry, abi: abis.registry, functionName: "headroom", args: [mandateId],
    });
    const under = equity < floor;
    const colour = under ? c.red : r < ALLOCATION / 50n ? c.yellow : c.green;
    console.log(
      `   ${colour}${px(next).padStart(13)}${c.r}  equity ${usd(equity).padStart(12)}` +
      `  floor ${usd(floor).padStart(12)}  ${under ? c.red + "UNDER THE FLOOR" + c.r : "headroom " + usd(r)}`,
    );
    await sleep(400);
  }

  // ── 5. enforcement, by a stranger ───────────────────────────────────────────
  step(5, "A stranger enforces it");
  const strangerPk = generatePrivateKey();
  const stranger = privateKeyToAccount(strangerPk);
  const strangerWallet = createWalletClient({
    account: stranger, chain: monadTestnet, transport: http(RPC),
  });
  const gasHash = await owner.sendTransaction({to: stranger.address, value: 10n ** 17n});
  await pub.waitForTransactionReceipt({hash: gasHash});

  note(`enforcing from ${stranger.address} — a wallet with no role in this system`);
  note("not the owner, not the issuer, not the keeper. markAndEnforce has no access modifier.");

  const enforceHash = await strangerWallet.writeContract({
    address: a.registry, abi: abis.registry, functionName: "markAndEnforce", args: [mandateId],
  });
  const enforceReceipt = await pub.waitForTransactionReceipt({hash: enforceHash});

  // ── 6. what happened ────────────────────────────────────────────────────────
  step(6, "Result");
  const finalState = await pub.readContract({
    address: a.registry, abi: abis.registry, functionName: "stateOf", args: [mandateId],
  });
  const openAfter = await pub.readContract({
    address: a.venue, abi: abis.venue, functionName: "openMarkets", args: [accountAddr],
  });

  tick(`status      ${c.red}${STATUS[Number(finalState[13])]}${c.r}`);
  tick(`reason      ${BREACH[Number(finalState[14])]}`);
  tick(`equity      ${usd(finalState[7])}`);
  tick(`positions   ${openAfter.length} open — flattened in the same transaction`);
  tick(`gas         ${enforceReceipt.gasUsed}`);

  line();
  console.log(`${c.b}Enforcement tx:${c.r} ${c.cyan}${explorer}/tx/${enforceHash}${c.r}`);
  console.log(
    `${c.d}One call, by anyone: marked to market, breached, position flattened,\n` +
    `capital returned to the pool, mandate revoked.${c.r}\n`,
  );
}

main().catch((e) => {
  console.error(`\n${c.red}demo failed:${c.r}`, e);
  process.exit(1);
});

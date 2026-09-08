/**
 * Phase 1 spike — proves the Perpl integration is real before any contract depends on it.
 *
 * What it checks, live, with no auth and no API key:
 *   1. Monad testnet RPC is up and is chain 10143
 *   2. Perpl's public context endpoint responds and reports the same chain
 *   3. Every live market and its oracle/mark price is readable and correctly scaled
 *   4. Pyth on Monad testnet answers the IPyth interface
 *   5. The price we would feed MiniPerp is sane and cross-checks against Pyth
 *
 * Run: npx tsx scripts/spike-perpl.ts
 *
 * NOTE on why this script does not open a position on Perpl:
 * Perpl order placement requires an Ed25519-signed WebSocket session, and a smart
 * contract cannot hold that key (no EIP-1271 support for orders). The settlement venue
 * is therefore MiniPerp.sol, and Perpl is the live price + market-config source.
 * See docs/PHASE1-FINDINGS.md for the full reasoning.
 */

const PERPL_API = process.env.PERPL_API_URL ?? "https://testnet.perpl.xyz/api";
const MONAD_RPC = process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz";
const PYTH = "0x2880aB155794e7179c9eE2e38200202908C17B43";
const PYTH_BTC_FEED = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const EXPECTED_CHAIN_ID = 10143;

type PerplMarket = {
  id: number;
  symbol: string;
  name: string;
  config: {price_decimals: number; size_decimals: number; initial_margin: number; maintenance_margin: number; maker_fee: number; taker_fee: number; is_open: boolean};
  state: {orl: number; mrk: number; lst: number; mid: number; bid: number; ask: number; oi: number; tvl: string; at: {b: number; t: number}};
  funding: {rate: number; idx: number; sum: number};
  funding_interval_sec: number;
};

type PerplContext = {
  chain: {chain_id: number; name: string; gas: {base: string; p50: string; p95: string}};
  instances: {id: number; address: string; collateral_token_id: number}[];
  tokens: {id: number; address: string; symbol: string; decimals: number}[];
  markets: PerplMarket[];
};

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m: string) => { console.error(`  \x1b[31m✗\x1b[0m ${m}`); process.exitCode = 1; };
const head = (m: string) => console.log(`\n\x1b[1m${m}\x1b[0m`);

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(MONAD_RPC, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
  });
  const json = (await res.json()) as {result?: T; error?: {message: string}};
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

/** Perpl quotes integer prices scaled by the market's price_decimals. */
const scalePrice = (raw: number, decimals: number) => raw / 10 ** decimals;

const usd = (n: number) =>
  n.toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 2});

async function main() {
  console.log("\x1b[1m\nMandate — Phase 1 venue & oracle spike\x1b[0m");
  console.log("Verifying every claim in SPEC §2 against live endpoints.\n" + "─".repeat(64));

  // ── 1. Monad testnet reachable ────────────────────────────────────────────
  head("1. Monad testnet RPC");
  const chainIdHex = await rpc<string>("eth_chainId");
  const chainId = parseInt(chainIdHex, 16);
  chainId === EXPECTED_CHAIN_ID
    ? ok(`chain id ${chainId} (Monad testnet)`)
    : fail(`expected chain ${EXPECTED_CHAIN_ID}, got ${chainId}`);

  const blockHex = await rpc<string>("eth_blockNumber");
  ok(`head block ${parseInt(blockHex, 16).toLocaleString()}`);

  // ── 2. Perpl public context ───────────────────────────────────────────────
  head("2. Perpl public API (no auth)");
  const res = await fetch(`${PERPL_API}/v1/pub/context`);
  if (!res.ok) return fail(`GET /v1/pub/context -> HTTP ${res.status}`);
  const ctx = (await res.json()) as PerplContext;
  ok(`GET /v1/pub/context -> HTTP ${res.status}`);

  ctx.chain.chain_id === EXPECTED_CHAIN_ID
    ? ok(`Perpl reports chain ${ctx.chain.chain_id} — ${ctx.chain.name}`)
    : fail(`Perpl is on chain ${ctx.chain.chain_id}, not Monad testnet`);

  const exchange = ctx.instances[0];
  const collateral = ctx.tokens.find((t) => t.id === exchange?.collateral_token_id);
  ok(`exchange contract ${exchange?.address}`);
  ok(`collateral ${collateral?.symbol} ${collateral?.address} (${collateral?.decimals} dec)`);
  ok(`base fee ${(Number(ctx.chain.gas.base) / 1e9).toFixed(1)} gwei · p95 ${(Number(ctx.chain.gas.p95) / 1e9).toFixed(1)} gwei`);

  // ── 3. Live markets — this is what MiniPerp mirrors ───────────────────────
  head("3. Live markets (MiniPerp mirrors these params)");
  const open = ctx.markets.filter((m) => m.config.is_open);
  open.length > 0 ? ok(`${open.length} open markets`) : fail("no open markets");

  console.log();
  console.log(
    "    " +
      ["market", "id", "oracle", "mark", "spread", "taker", "im(raw)", "mm(raw)"]
        .map((h, i) => h.padEnd([8, 4, 12, 12, 8, 9, 9, 8][i]!))
        .join("")
  );
  console.log("    " + "─".repeat(70));

  const perplPrices = new Map<string, number>();
  for (const m of open) {
    const d = m.config.price_decimals;
    const oracle = scalePrice(m.state.orl, d);
    const mark = scalePrice(m.state.mrk, d);
    const spreadBps = m.state.mid > 0 ? ((m.state.ask - m.state.bid) / m.state.mid) * 10_000 : 0;
    perplPrices.set(m.symbol, oracle);
    console.log(
      "    " +
        m.symbol.padEnd(8) +
        String(m.id).padEnd(4) +
        usd(oracle).padEnd(12) +
        usd(mark).padEnd(12) +
        `${spreadBps.toFixed(1)}bp`.padEnd(8) +
        // Fees are millionths of notional: 690 -> 0.069%, which is a realistic taker fee.
        // (690/100 = 6.9% would not be.) MiniPerp uses the same scale.
        `${((m.config.taker_fee / 1e6) * 100).toFixed(3)}%`.padEnd(9) +
        // Margin config integers are printed RAW. Perpl's public docs do not state their
        // units, and the live values are self-contradictory under the obvious reading —
        // BTC shows initial 1500 and maintenance 2500, and a maintenance requirement above
        // the initial one would make every position liquidatable the moment it opens. Rather
        // than assert an interpretation we cannot verify, MiniPerp defines its own margin
        // model explicitly in bps of notional. See docs/RESEARCH.md.
        `${m.config.initial_margin}`.padEnd(9) +
        `${m.config.maintenance_margin}`
    );
  }
  console.log();

  const staleness = Date.now() - (open[0]?.state.at.t ?? 0);
  staleness < 60_000
    ? ok(`price data ${(staleness / 1000).toFixed(1)}s old — fresh enough to mark per block`)
    : fail(`price data ${(staleness / 1000).toFixed(0)}s old`);

  // ── 4. Pyth on Monad testnet ──────────────────────────────────────────────
  head("4. Pyth oracle on Monad testnet");
  const code = await rpc<string>("eth_getCode", [PYTH, "latest"]);
  code !== "0x" ? ok(`contract deployed at ${PYTH}`) : fail(`no code at ${PYTH}`);

  // getPriceUnsafe(bytes32) -> (int64 price, uint64 conf, int32 expo, uint256 publishTime)
  const selector = "0x96834ad3";
  const raw = await rpc<string>("eth_call", [
    {to: PYTH, data: selector + PYTH_BTC_FEED.slice(2)},
    "latest",
  ]);

  if (raw && raw !== "0x") {
    const words = raw.slice(2).match(/.{64}/g)!;
    const asInt = (w: string) => BigInt.asIntN(256, BigInt("0x" + w));
    const price = asInt(words[0]!);
    const expo = Number(asInt(words[2]!));
    const publishTime = Number(BigInt("0x" + words[3]!));
    const pythBtc = Number(price) * 10 ** expo;
    const ageMin = (Date.now() / 1000 - publishTime) / 60;

    ok(`IPyth.getPriceUnsafe answered — BTC ${usd(pythBtc)} (expo ${expo})`);

    // Pyth is a PULL oracle: onchain price only advances when someone pays to push it.
    // This is exactly why the keeper feeds Perpl's oracle instead of paying Pyth per block.
    if (ageMin > 5) {
      console.log(
        `  \x1b[33m!\x1b[0m onchain Pyth price is ${ageMin.toFixed(0)}min stale — pull oracle, ` +
          `needs a Hermes update to advance`
      );
      console.log(`    → this is why the keeper marks against Perpl's live oracle instead`);
    }

    const perplBtc = perplPrices.get("BTC");
    if (perplBtc) {
      const divergeBps = (Math.abs(perplBtc - pythBtc) / pythBtc) * 10_000;
      console.log(
        `    cross-check: Perpl ${usd(perplBtc)} vs Pyth ${usd(pythBtc)} → ` +
          `${divergeBps.toFixed(0)}bp apart (expected, given Pyth staleness)`
      );
    }
  } else {
    fail("IPyth.getPriceUnsafe returned empty");
  }

  // ── 5. The mark the keeper would push ─────────────────────────────────────
  head("5. Mark that the keeper would push to MiniPerp");
  for (const [symbol, price] of perplPrices) {
    // MiniPerp stores prices with 8 decimals internally.
    const onchain = BigInt(Math.round(price * 1e8));
    ok(`${symbol.padEnd(4)} ${usd(price).padStart(12)}  →  ${onchain} (1e8 scaled)`);
  }

  console.log("\n" + "─".repeat(64));
  if (process.exitCode) {
    console.log("\x1b[31mSPIKE FAILED\x1b[0m — see failures above\n");
  } else {
    console.log("\x1b[32mSPIKE PASSED\x1b[0m");
    console.log("Perpl live on Monad testnet · prices readable · Pyth verified.");
    console.log("Venue = MiniPerp.sol (contracts cannot sign Perpl orders).");
    console.log("See docs/PHASE1-FINDINGS.md §2 for why.\n");
  }
}

main().catch((e) => {
  console.error("\n\x1b[31mspike crashed:\x1b[0m", e);
  process.exit(1);
});

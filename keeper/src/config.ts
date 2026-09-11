import {config as loadEnv} from "dotenv";
import {defineChain, type Address, type Hex} from "viem";
import {resolve} from "node:path";

loadEnv({path: resolve(process.cwd(), ".env")});
loadEnv({path: resolve(process.cwd(), "../.env")});

/**
 * Monad testnet. Chain id and RPC verified live in Phase 1 —
 * see docs/PHASE1-FINDINGS.md §1.
 */
export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: {name: "MON", symbol: "MON", decimals: 18},
  rpcUrls: {
    default: {http: [process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz"]},
  },
  blockExplorers: {
    default: {name: "MonadScan", url: "https://testnet.monadscan.com"},
  },
});

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env — copy .env.example and fill it in`);
  return v;
}

function addr(name: string): Address {
  const v = required(name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${name} is not an address: ${v}`);
  return v as Address;
}

export const cfg = {
  rpcUrl: process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz",
  privateKey: required("KEEPER_PRIVATE_KEY") as Hex,

  registry: addr("MANDATE_REGISTRY_ADDRESS"),
  oracle: addr("ORACLE_ADDRESS"),
  venue: addr("MINI_PERP_ADDRESS"),
  pool: addr("CAPITAL_POOL_ADDRESS"),

  /** Perpl's public context endpoint. No auth, no API key. */
  perplApi: process.env.PERPL_API_URL ?? "https://testnet.perpl.xyz/api",

  /** How often to poll for a new block. Monad blocks are ~400ms. */
  pollMs: Number(process.env.KEEPER_BLOCK_POLL_MS ?? 250),
  /** Mandates per markAndEnforceBatch call. */
  maxBatch: Number(process.env.KEEPER_MAX_BATCH ?? 25),

  // ── gas economy ────────────────────────────────────────────────────────────
  //
  // On a local fork every transaction is free, and marking every block is the natural
  // rhythm. On the public testnet the base fee is ~100 gwei, a batch mark of five
  // mandates is ~400k gas, and a keeper that marks every 400ms drains a deployer wallet
  // in minutes. The first live run proved it: 1.1 MON gone before anyone noticed.
  //
  // The economics of the PRODUCT are unchanged — at ~$0.03/MON a mark is ~$0.0003, which
  // is the sub-cent figure the pitch relies on. What is scarce on testnet is MON itself,
  // because the faucet doles it out in small amounts. So on the public network the keeper
  // marks on demand: it reads every mandate's live equity against its floor every few
  // seconds (reads are free), sends a mark only when one is at or under its floor, and
  // otherwise marks everything on a slow schedule so lastMarkedEquity does not drift too
  // far. Enforcement stays prompt; routine marking stops costing anything.

  /** "block" marks every block (fork). "demand" marks on breach + a slow schedule (live). */
  mode: (process.env.KEEPER_MODE ?? "demand") as "block" | "demand",
  /** demand mode: how often to read live equity vs floor. Free. */
  watchIntervalMs: Number(process.env.KEEPER_WATCH_INTERVAL_MS ?? 8_000),
  /** demand mode: mark everything at least this often regardless. */
  routineMarkIntervalMs: Number(process.env.KEEPER_ROUTINE_MARK_MS ?? 5 * 60_000),
  /** Mark a mandate proactively once its headroom is under this many bps. */
  nearFloorBps: Number(process.env.KEEPER_NEAR_FLOOR_BPS ?? 25),

  /** Skip a price push if no market moved more than this since the last push. */
  minPriceMoveBps: Number(process.env.KEEPER_MIN_PRICE_MOVE_BPS ?? 40),
  /** Push prices at least this often — must stay under the oracle's staleness bound. */
  maxPriceAgeMs: Number(process.env.KEEPER_MAX_PRICE_AGE_MS ?? 4 * 60_000),
  /** Stop sending transactions below this balance so the wallet is never fully drained. */
  minBalanceMon: Number(process.env.KEEPER_MIN_BALANCE_MON ?? 0.02),

  storePath: process.env.KEEPER_STORE_PATH ?? "./keeper/data/marks.json",
} as const;

/**
 * Markets the keeper relays. Ids are Perpl's real market ids, confirmed against
 * /api/v1/pub/context during Phase 1.
 */
export const MARKETS: {id: number; symbol: string}[] = [
  {id: 16, symbol: "BTC"},
  {id: 32, symbol: "ETH"},
  {id: 48, symbol: "SOL"},
];

export const PRICE_SCALE = 100_000_000n; // 1e8
export const ASSET_SCALE = 1_000_000n; // 1e6

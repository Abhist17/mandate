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
  /** Skip a price push if the market moved less than this since the last one. */
  minPriceMoveBps: Number(process.env.KEEPER_MIN_PRICE_MOVE_BPS ?? 1),
  /** Force a price push at least this often even when the market is flat. */
  maxPriceAgeMs: Number(process.env.KEEPER_MAX_PRICE_AGE_MS ?? 20_000),

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

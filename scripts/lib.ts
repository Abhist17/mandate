/** Shared plumbing for the seed and demo scripts. */
import {createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {config as loadEnv} from "dotenv";

loadEnv();

export const RPC = process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz";

export const monadTestnet = {
  id: Number(process.env.MONAD_TESTNET_CHAIN_ID ?? 10143),
  name: "Monad Testnet",
  nativeCurrency: {name: "MON", symbol: "MON", decimals: 18},
  rpcUrls: {default: {http: [RPC]}},
  blockExplorers: {default: {name: "MonadScan", url: "https://testnet.monadscan.com"}},
} as const;

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} — run the deploy script and fill in .env`);
  return v;
}

export const addrs = () => ({
  asset: env("POOL_ASSET_ADDRESS") as Address,
  oracle: env("ORACLE_ADDRESS") as Address,
  venue: env("MINI_PERP_ADDRESS") as Address,
  registry: env("MANDATE_REGISTRY_ADDRESS") as Address,
  pool: env("CAPITAL_POOL_ADDRESS") as Address,
});

export const pub = createPublicClient({
  chain: monadTestnet,
  transport: http(RPC, {retryCount: 5, timeout: 20_000}),
});

export function wallet(pk?: string) {
  const account = privateKeyToAccount((pk ?? env("PRIVATE_KEY")) as Hex);
  return createWalletClient({account, chain: monadTestnet, transport: http(RPC, {timeout: 20_000})});
}

export const abis = {
  erc20: parseAbi([
    "function mint(address to, uint256 amount)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
  ]),
  oracle: parseAbi([
    "function pushPrice(uint16 marketId, uint256 newPrice, uint64 publishedAt)",
    "function forcePrice(uint16 marketId, uint256 newPrice, uint64 publishedAt)",
    "function price(uint16 marketId) view returns (uint256, uint64)",
    "function setPublisher(address publisher, bool allowed)",
  ]),
  registry: parseAbi([
    "function issue(address trader, (uint256,uint16,uint16,uint16,uint16,uint64,uint8,uint8,uint16,uint16,uint16,bool) terms) returns (uint256)",
    "function markAndEnforce(uint256 mandateId) returns (bool)",
    "function stateOf(uint256) view returns ((address,address,uint256,uint256,uint256,uint64,uint256,uint64,uint64,uint256,uint32,uint32,uint8,uint8))",
    "function termsOf(uint256) view returns ((uint256,uint16,uint16,uint16,uint16,uint64,uint8,uint8,uint16,uint16,uint16,bool))",
    "function headroom(uint256) view returns (uint256,uint256)",
    "function floorOf(uint256) view returns (uint256,uint256)",
    "function liveEquity(uint256) view returns (uint256)",
    "function activeMandates() view returns (uint256[])",
    "function setIssuer(address,bool)",
    "function closeMandate(uint256)",
    "function payoutEligibility(uint256) view returns (bool,uint8)",
    "function consistencyScore(uint256) view returns (uint256)",
  ]),
  account: parseAbi([
    "function openPosition(uint16 marketId, bool isLong, uint256 size, uint256 limitPrice) returns (uint256)",
    "function closePosition(uint16 marketId, uint256 limitPrice) returns (int256)",
    "function equity() view returns (uint256)",
    "function notional() view returns (uint256)",
  ]),
  pool: parseAbi([
    "function deposit(uint256 assets, address receiver) returns (uint256)",
    "function totalAssets() view returns (uint256)",
    "function idleAssets() view returns (uint256)",
    "function pricePerShare() view returns (uint256)",
  ]),
  venue: parseAbi([
    "function fundReserve(uint256 amount)",
    "function openMarkets(address) view returns (uint16[])",
    "function totalNotional(address) view returns (uint256)",
  ]),
};

export const ONE = 1_000_000n; // 6-decimal asset
export const PRICE = 100_000_000n; // 1e8

export const usd = (v: bigint, d = 6) =>
  (Number(v) / 10 ** d).toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 2});

export const px = (v: bigint) => usd(v, 8);

export const STATUS = ["None", "Active", "Breached", "Expired", "Closed"] as const;
export const BREACH = ["None", "TrailingDrawdown", "DailyLoss", "Expiry"] as const;

export const c = {
  b: "\x1b[1m",
  d: "\x1b[2m",
  r: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Matches Types.DrawdownMode. */
export const DrawdownMode = {Static: 0, Trailing: 1, TrailingUntilBreakeven: 2} as const;

/** Matches Types.PayoutBlock. */
export const PAYOUT_BLOCK = ["None", "Consistency", "ProfitableDays", "Cushion"] as const;

/** Terms tuple in the order MandateRegistry.issue expects. */
export function terms(o: {
  allocation: bigint;
  maxDrawdownBps: number;
  dailyLossBps: number;
  profitSplitBps: number;
  maxPositionBps: number;
  expiry: bigint;
  resetHourUtc?: number;
  drawdownMode?: number;
  maxConsistencyBps?: number;
  minProfitableDays?: number;
  payoutCushionBps?: number;
  touchIsBreach?: boolean;
}) {
  return [
    o.allocation,
    o.maxDrawdownBps,
    o.dailyLossBps,
    o.profitSplitBps,
    o.maxPositionBps,
    o.expiry,
    o.resetHourUtc ?? 0,
    o.drawdownMode ?? DrawdownMode.Trailing,
    o.maxConsistencyBps ?? 0,
    o.minProfitableDays ?? 0,
    o.payoutCushionBps ?? 0,
    o.touchIsBreach ?? false,
  ] as const;
}

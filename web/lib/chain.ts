import {createPublicClient, http, defineChain, type Address} from "viem";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143);
export const RPC_URL = process.env.NEXT_PUBLIC_MONAD_RPC ?? "https://testnet-rpc.monad.xyz";

export const monadTestnet = defineChain({
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: {name: "MON", symbol: "MON", decimals: 18},
  rpcUrls: {default: {http: [RPC_URL]}},
  blockExplorers: {default: {name: "MonadScan", url: "https://testnet.monadscan.com"}},
});

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(RPC_URL, {retryCount: 3, timeout: 15_000}),
});

const asAddress = (v: string | undefined): Address =>
  (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : "0x0000000000000000000000000000000000000000") as Address;

export const ADDR = {
  registry: asAddress(process.env.NEXT_PUBLIC_REGISTRY),
  pool: asAddress(process.env.NEXT_PUBLIC_POOL),
  venue: asAddress(process.env.NEXT_PUBLIC_VENUE),
  oracle: asAddress(process.env.NEXT_PUBLIC_ORACLE),
  asset: asAddress(process.env.NEXT_PUBLIC_ASSET),
  demoIssuer: asAddress(process.env.NEXT_PUBLIC_DEMO_ISSUER),
};

export const ZERO = "0x0000000000000000000000000000000000000000";
export const hasDemoIssuer = ADDR.demoIssuer !== ZERO;

export const isConfigured = ADDR.registry !== "0x0000000000000000000000000000000000000000";

export const explorerTx = (hash: string) => `https://testnet.monadscan.com/tx/${hash}`;
export const explorerAddr = (a: string) => `https://testnet.monadscan.com/address/${a}`;

/** Perpl's real market ids on Monad testnet — see docs/PHASE1-FINDINGS.md. */
export const MARKETS = [
  {id: 16, symbol: "BTC", sizeStep: 0.01},
  {id: 32, symbol: "ETH", sizeStep: 0.1},
  {id: 48, symbol: "SOL", sizeStep: 1},
] as const;

export const STATUS = ["None", "Active", "Breached", "Expired", "Closed"] as const;
export const BREACH_KIND = ["None", "Trailing drawdown", "Daily loss", "Expiry"] as const;

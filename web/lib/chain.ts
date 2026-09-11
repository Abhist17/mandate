import {createPublicClient, http, fallback, defineChain, type Address} from "viem";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143);
export const RPC_URL = process.env.NEXT_PUBLIC_MONAD_RPC ?? "https://testnet-rpc.monad.xyz";

export const monadTestnet = defineChain({
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: {name: "MON", symbol: "MON", decimals: 18},
  rpcUrls: {default: {http: [RPC_URL]}},
  blockExplorers: {default: {name: "MonadScan", url: "https://testnet.monadscan.com"}},
  // Multicall3 at its canonical address — verified deployed on Monad testnet. With it viem
  // folds every readContract issued in the same tick into ONE eth_call, which is the
  // difference between the trader page loading in 300ms and never loading at all against
  // a real RPC. On a local fork each call took 2ms and nobody noticed the fan-out.
  contracts: {
    multicall3: {address: "0xcA11bde05977b3631167028862bE2a173976CA11"},
  },
});

/**
 * Public Monad testnet RPCs, in preference order.
 *
 * Every one of these throttles under load — a single eth_call was measured at 11 seconds on
 * the primary during a busy period — and a page that depends on one endpoint is a page that
 * hangs whenever that endpoint has a bad minute. viem's fallback transport moves to the next
 * one on error or timeout, and ranks them by observed latency, so the app quietly uses
 * whichever is healthiest right now.
 *
 * Only used when the configured RPC is the public network. A local fork is a single
 * endpoint and must stay that way — failing over from it to the real network would send
 * reads to a chain where the contracts do not exist.
 */
const PUBLIC_RPCS = [
  "https://testnet-rpc.monad.xyz",
  "https://rpc.ankr.com/monad_testnet",
  "https://monad-testnet.rpc.thirdweb.com",
  "https://rpc-testnet.monadinfra.com",
];

const isPublicNetwork = PUBLIC_RPCS.includes(RPC_URL);

const transport = isPublicNetwork
  ? fallback(
      // The configured one first, then the rest.
      [RPC_URL, ...PUBLIC_RPCS.filter((u) => u !== RPC_URL)].map((url) =>
        http(url, {retryCount: 1, timeout: 8_000}),
      ),
      {rank: {interval: 60_000, sampleCount: 3}, retryCount: 2},
    )
  : http(RPC_URL, {retryCount: 3, timeout: 20_000});

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport,
  // Batch JSON-RPC at the transport level AND multicall at the contract level.
  batch: {multicall: {wait: 16}},
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
  book: asAddress(process.env.NEXT_PUBLIC_BOOK),
};

export const ZERO = "0x0000000000000000000000000000000000000000";
export const hasDemoIssuer = ADDR.demoIssuer !== ZERO;
export const hasBook = ADDR.book !== ZERO;

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

/** Convenience re-export guard used by the market page. */
export const shortAddrSafe = true;

/**
 * Wait for a transaction and REFUSE to call it done if it reverted.
 *
 * viem's waitForTransactionReceipt resolves as soon as the transaction is mined — including
 * when it reverted. A reverted transaction has a receipt; its status is just "reverted". Every
 * action in this app was treating "mined" as "worked", and a tester saw "Short 10 ETH filled"
 * in one corner of the screen while MetaMask reported the same transaction as failed in the
 * other. The contract had refused the order (stale price); the app said it filled.
 *
 * Throws with the revert reason where the node gives one, so the toast can show it.
 */
export async function awaitTx(hash: `0x${string}`): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({hash, timeout: 90_000});
  if (receipt.status === "reverted") {
    // Replay the call at that block to recover the custom error, if the RPC will tell us.
    let reason = "reverted on-chain";
    try {
      const tx = await publicClient.getTransaction({hash});
      await publicClient.call({
        account: tx.from,
        to: tx.to ?? undefined,
        data: tx.input,
        value: tx.value,
        blockNumber: receipt.blockNumber,
      });
    } catch (e) {
      const m = String(e).match(/(?:custom error|reverted with|Error:)\s*([A-Za-z]+[A-Za-z0-9_]*)/);
      if (m?.[1]) reason = m[1];
      else if (String(e).includes("0x276a9723")) reason = "StalePrice";
    }
    throw new Error(`Transaction ${reason}`);
  }
}

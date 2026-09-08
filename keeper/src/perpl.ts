import {cfg, MARKETS, PRICE_SCALE} from "./config.js";

/**
 * Perpl's public market feed.
 *
 * `GET /api/v1/pub/context` needs no auth and no API key, and returns per-market live state
 * including the oracle price (`orl`), mark price (`mrk`), top of book, open interest and
 * funding. Prices are integers scaled by each market's `price_decimals`.
 *
 * This is the load-bearing Perpl integration: mandates are marked, and breaches triggered,
 * against these prices. Market ids and precision are discovered at runtime rather than
 * hard-coded, because Perpl's docs say market ids are network-specific and can change.
 */

export type PerplMarket = {
  id: number;
  symbol: string;
  config: {price_decimals: number; size_decimals: number; is_open: boolean; taker_fee: number};
  state: {orl: number; mrk: number; mid: number; bid: number; ask: number; oi: number; at: {b: number; t: number}};
  funding: {rate: number; sum: number};
};

type PerplContext = {
  chain: {chain_id: number; name: string; gas: {base: string; p50: string; p95: string}};
  markets: PerplMarket[];
};

export type MarketPrice = {
  id: number;
  symbol: string;
  /** USD, human readable. */
  usd: number;
  /** Scaled 1e8, the form pushed onchain. */
  onchain: bigint;
  /** Source timestamp, unix seconds. */
  publishedAt: number;
};

export type PerplSnapshot = {
  prices: MarketPrice[];
  chainId: number;
  baseFeeGwei: number;
  fetchedAt: number;
};

/** Perpl quotes integer prices scaled by the market's own price_decimals. */
function toUsd(raw: number, decimals: number): number {
  return raw / 10 ** decimals;
}

export async function fetchPerplPrices(timeoutMs = 4_000): Promise<PerplSnapshot> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.perplApi}/v1/pub/context`, {signal: ctrl.signal});
    if (!res.ok) throw new Error(`Perpl context HTTP ${res.status}`);
    const ctx = (await res.json()) as PerplContext;

    const wanted = new Set(MARKETS.map((m) => m.id));
    const prices: MarketPrice[] = [];

    for (const m of ctx.markets) {
      if (!wanted.has(m.id) || !m.config.is_open) continue;
      const usd = toUsd(m.state.orl, m.config.price_decimals);
      if (!Number.isFinite(usd) || usd <= 0) continue;
      prices.push({
        id: m.id,
        symbol: m.symbol,
        usd,
        // Round rather than truncate: truncation biases every price down, and a systematic
        // downward bias on the mark is a systematic bias against every long position.
        onchain: BigInt(Math.round(usd * Number(PRICE_SCALE))),
        publishedAt: Math.floor(m.state.at.t / 1000),
      });
    }

    return {
      prices,
      chainId: ctx.chain.chain_id,
      baseFeeGwei: Number(ctx.chain.gas.base) / 1e9,
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

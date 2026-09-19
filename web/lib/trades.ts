"use client";

import {parseAbiItem, type Address} from "viem";
import {ADDR, publicClient} from "./chain";
import {walkLogs} from "./logs";

/**
 * Closed trades, reconstructed from the venue's own events.
 *
 * Funded-trading dashboards all carry a journal, and it is the section traders actually
 * spend time in — FTMO builds a whole analytics product on theirs. This is the same idea
 * with one property theirs cannot have: the rows are not a report the firm compiled about
 * you. They are `PositionOpened` and `PositionClosed` logs emitted by the venue contract,
 * readable by anyone, and a trade that happened cannot be missing from them.
 *
 * That matters most for the last column. When a mandate breaches, enforcement flattens the
 * book, and those closes carry the same event as any other — so a trade closed *by the
 * contract* is visible as such, at a block anyone can check, rather than appearing as an
 * ordinary exit in a statement.
 */

const openedEvent = parseAbiItem(
  "event PositionOpened(address indexed account, uint16 indexed marketId, bool isLong, uint256 size, uint256 fillPrice, uint256 notional, uint256 margin, uint256 fee)",
);

const closedEvent = parseAbiItem(
  "event PositionClosed(address indexed account, uint16 indexed marketId, uint256 size, uint256 fillPrice, int256 realisedPnl, uint256 fee, int256 funding)",
);

// Enforcement closes a book by calling venue.flatten(), which emits Flattened — NOT
// Liquidated, which is the separate margin path. Watching only the latter meant a mandate
// the contract had shut down showed its exits as ordinary trader closes, which is exactly
// the distinction this column exists to draw.
const flattenedEvent = parseAbiItem(
  "event Flattened(address indexed account, address indexed by, int256 realisedPnl, uint256 positionsClosed)",
);

const liquidatedEvent = parseAbiItem(
  "event Liquidated(address indexed account, uint16 indexed marketId, address indexed by, int256 realisedPnl)",
);

const ASSET = 1e6;   // pool asset (USDC-style)
const PRICE = 1e8;   // oracle prices
const SIZE = 1e18;  // contract size

export const SYMBOLS: Record<number, string> = {16: "BTC", 32: "ETH", 48: "SOL"};

export type Trade = {
  key: string;
  marketId: number;
  symbol: string;
  isLong: boolean;
  size: number;
  entryPrice: number;
  exitPrice: number;
  realisedPnl: number;
  fee: number;
  funding: number;
  openedAt: number; // unix seconds, 0 if the open fell outside the window
  closedAt: number;
  openBlock: number;
  closeBlock: number;
  /** The transaction that closed it — the row's own receipt. */
  txHash: string;
  /** True when this close was the contract flattening the book, not the trader exiting. */
  enforced: boolean;
};

/**
 * Pair opens with closes for one mandate account.
 *
 * Positions are one-per-market in MiniPerp, so an open is closed by the next close on the
 * same market. Anything still unpaired at the end is an open position and belongs in the
 * open-positions table instead.
 */
export async function fetchTrades(account: Address): Promise<Trade[]> {
  const [opens, closes, flattens, liquidations] = await Promise.all([
    walkLogs({address: ADDR.venue as Address, event: openedEvent, args: {account}}),
    walkLogs({address: ADDR.venue as Address, event: closedEvent, args: {account}}),
    walkLogs({address: ADDR.venue as Address, event: flattenedEvent, args: {account}}),
    walkLogs({address: ADDR.venue as Address, event: liquidatedEvent, args: {account}}),
  ]);

  // Blocks carry the timestamps; fetch each one once rather than per row.
  const blocks = new Set<bigint>();
  for (const l of [...opens, ...closes]) if (l.blockNumber) blocks.add(l.blockNumber);
  const times = await blockTimes([...blocks]);

  // A close sharing a block with a flatten or a liquidation was not the trader's decision.
  const enforcedAt = new Set(
    [...flattens, ...liquidations].map((l) => String(l.blockNumber)),
  );

  const pending = new Map<number, (typeof opens)[number][]>();
  for (const o of opens) {
    const m = Number(o.args.marketId ?? 0);
    if (!pending.has(m)) pending.set(m, []);
    pending.get(m)!.push(o);
  }

  const trades: Trade[] = [];
  for (const c of closes) {
    const marketId = Number(c.args.marketId ?? 0);
    const queue = pending.get(marketId);
    const o = queue?.shift();

    trades.push({
      key: `${c.blockNumber}-${c.logIndex}`,
      marketId,
      symbol: SYMBOLS[marketId] ?? `#${marketId}`,
      isLong: Boolean(o?.args.isLong),
      size: Number(c.args.size ?? 0n) / SIZE,
      entryPrice: Number(o?.args.fillPrice ?? 0n) / PRICE,
      exitPrice: Number(c.args.fillPrice ?? 0n) / PRICE,
      realisedPnl: Number(c.args.realisedPnl ?? 0n) / ASSET,
      fee: Number(c.args.fee ?? 0n) / ASSET,
      funding: Number(c.args.funding ?? 0n) / ASSET,
      openedAt: times.get(String(o?.blockNumber)) ?? 0,
      closedAt: times.get(String(c.blockNumber)) ?? 0,
      openBlock: Number(o?.blockNumber ?? 0n),
      closeBlock: Number(c.blockNumber ?? 0n),
      txHash: c.transactionHash ?? "",
      enforced: enforcedAt.has(String(c.blockNumber)),
    });
  }

  // Newest first: a journal is read from the most recent trade backwards.
  return trades.reverse();
}

async function blockTimes(numbers: bigint[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const CHUNK = 8;
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const slice = numbers.slice(i, i + CHUNK);
    const got = await Promise.all(
      slice.map((n) =>
        publicClient
          .getBlock({blockNumber: n})
          .then((b) => [String(n), Number(b.timestamp)] as const)
          .catch(() => [String(n), 0] as const),
      ),
    );
    for (const [k, v] of got) out.set(k, v);
  }
  return out;
}

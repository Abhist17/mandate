"use client";

import {useCallback, useEffect, useRef, useState} from "react";
import type {Address} from "viem";
import {publicClient, ADDR, MARKETS} from "./chain";
import {registryAbi, poolAbi, venueAbi, oracleAbi, accountAbi, venueExtraAbi, poolExtraAbi} from "./abi";

export type Terms = {
  allocation: bigint;
  maxDrawdownBps: number;
  dailyLossBps: number;
  profitSplitBps: number;
  maxPositionBps: number;
  expiry: bigint;
  resetHourUtc: number;
  drawdownMode: number; // 0 Static, 1 Trailing, 2 TrailingUntilBreakeven
  maxConsistencyBps: number;
  minProfitableDays: number;
  payoutCushionBps: number;
  touchIsBreach: boolean;
};

export type MandateState = {
  trader: Address;
  account: Address;
  /** address(0) = funded by the shared pool; otherwise the LP underwriting this trader. */
  backer: Address;
  highWaterMark: bigint;
  dayStartEquity: bigint;
  dayStartBalance: bigint;
  dayStartTime: bigint;
  lastMarkedEquity: bigint;
  lastMarkedAt: bigint;
  issuedAt: bigint;
  largestDailyGain: bigint;
  profitableDays: number;
  tradingDays: number;
  status: number;
  breachKind: number;
};

export type Mandate = {
  id: bigint;
  terms: Terms;
  state: MandateState;
  liveEquity: bigint;
  floor: bigint;
  headroom: bigint;
  headroomBps: bigint;
  notional: bigint;
  positions: Position[];
  consistencyBps: bigint;
  payoutOk: boolean;
  payoutBlock: number; // 0 None, 1 Consistency, 2 ProfitableDays, 3 Cushion
};

export type Position = {
  marketId: number;
  symbol: string;
  isLong: boolean;
  size: bigint;
  entryPrice: bigint;
  margin: bigint;
  markPrice: bigint;
  unrealised: bigint;
};

export type PoolStats = {
  totalAssets: bigint;
  idle: bigint;
  allocated: bigint;
  pricePerShare: bigint;
  utilisationBps: bigint;
};

const NOTIONAL_DIVISOR = 10n ** 20n;

/**
 * Read a struct field returned by viem.
 *
 * viem decodes a tuple whose ABI components are NAMED into an object keyed by those names,
 * and one with unnamed components into a positional array. Our contract ABIs name their
 * fields, so these come back as objects — indexing them positionally silently yields
 * `undefined` for every field, which then surfaces far away as
 * "Cannot read properties of undefined". Reading by name with a positional fallback works
 * for either shape and cannot fail quietly.
 */
function field<T>(struct: unknown, name: string, index: number): T {
  const s = struct as Record<string, unknown> & ArrayLike<unknown>;
  return (name in s ? s[name] : s[index]) as T;
}

function tupleToTerms(t: unknown): Terms {
  return {
    allocation: field<bigint>(t, "allocation", 0),
    maxDrawdownBps: Number(field(t, "maxDrawdownBps", 1)),
    dailyLossBps: Number(field(t, "dailyLossBps", 2)),
    profitSplitBps: Number(field(t, "profitSplitBps", 3)),
    maxPositionBps: Number(field(t, "maxPositionBps", 4)),
    expiry: field<bigint>(t, "expiry", 5),
    resetHourUtc: Number(field(t, "resetHourUtc", 6)),
    drawdownMode: Number(field(t, "drawdownMode", 7)),
    maxConsistencyBps: Number(field(t, "maxConsistencyBps", 8)),
    minProfitableDays: Number(field(t, "minProfitableDays", 9)),
    payoutCushionBps: Number(field(t, "payoutCushionBps", 10)),
    touchIsBreach: Boolean(field(t, "touchIsBreach", 11)),
  };
}

function tupleToState(t: unknown): MandateState {
  return {
    trader: field<Address>(t, "trader", 0),
    account: field<Address>(t, "account", 1),
    backer: field<Address>(t, "backer", 2),
    highWaterMark: field<bigint>(t, "highWaterMark", 3),
    dayStartEquity: field<bigint>(t, "dayStartEquity", 4),
    dayStartBalance: field<bigint>(t, "dayStartBalance", 5),
    dayStartTime: field<bigint>(t, "dayStartTime", 6),
    lastMarkedEquity: field<bigint>(t, "lastMarkedEquity", 7),
    lastMarkedAt: field<bigint>(t, "lastMarkedAt", 8),
    issuedAt: field<bigint>(t, "issuedAt", 9),
    largestDailyGain: field<bigint>(t, "largestDailyGain", 10),
    profitableDays: Number(field(t, "profitableDays", 11)),
    tradingDays: Number(field(t, "tradingDays", 12)),
    status: Number(field(t, "status", 13)),
    breachKind: Number(field(t, "breachKind", 14)),
  };
}

async function readPositions(account: Address): Promise<Position[]> {
  const openIds = (await publicClient.readContract({
    address: ADDR.venue,
    abi: venueAbi,
    functionName: "openMarkets",
    args: [account],
  })) as readonly number[];

  const out: Position[] = [];
  for (const marketId of openIds) {
    const [pos, markPrice] = await Promise.all([
      publicClient.readContract({
        address: ADDR.venue,
        abi: venueExtraAbi,
        functionName: "getPosition",
        args: [account, marketId],
      }) as Promise<{
        isLong: boolean;
        size: bigint;
        entryPrice: bigint;
        margin: bigint;
      }>, // named components, so viem returns an object — see `field` above
      publicClient
        .readContract({address: ADDR.oracle, abi: oracleAbi, functionName: "price", args: [marketId]})
        .then((r) => (r as readonly [bigint, bigint])[0]),
    ]);

    // Mirrors MiniPerp._positionPnl so the screen agrees with the contract.
    const diff = markPrice - pos.entryPrice;
    const raw = (diff * pos.size) / NOTIONAL_DIVISOR;
    out.push({
      marketId,
      symbol: MARKETS.find((m) => m.id === marketId)?.symbol ?? `#${marketId}`,
      isLong: pos.isLong,
      size: pos.size,
      entryPrice: pos.entryPrice,
      margin: pos.margin,
      markPrice,
      unrealised: pos.isLong ? raw : -raw,
    });
  }
  return out;
}

export async function fetchMandate(id: bigint): Promise<Mandate | undefined> {
  const [termsTuple, stateTuple] = await Promise.all([
    publicClient.readContract({address: ADDR.registry, abi: registryAbi, functionName: "termsOf", args: [id]}),
    publicClient.readContract({address: ADDR.registry, abi: registryAbi, functionName: "stateOf", args: [id]}),
  ]);

  const state = tupleToState(stateTuple);
  if (state.status === 0) return undefined;
  const terms = tupleToTerms(termsTuple);

  const isActive = state.status === 1;

  // Positions are the reads most likely to time out on a public RPC (one per market, each
  // needing an oracle read). If they fail, show the mandate without them rather than dropping
  // the mandate from the page — which made cards appear and vanish between polls.
  const [floorTuple, headroomTuple, liveEquity, notional, positions] = await Promise.all([
    publicClient.readContract({address: ADDR.registry, abi: registryAbi, functionName: "floorOf", args: [id]}),
    isActive
      ? publicClient.readContract({address: ADDR.registry, abi: registryAbi, functionName: "headroom", args: [id]})
      : Promise.resolve([0n, 0n] as const),
    isActive
      ? (publicClient.readContract({
          address: ADDR.registry,
          abi: registryAbi,
          functionName: "liveEquity",
          args: [id],
        }) as Promise<bigint>)
      : Promise.resolve(state.lastMarkedEquity),
    isActive
      ? (publicClient.readContract({
          address: state.account,
          abi: accountAbi,
          functionName: "notional",
        }) as Promise<bigint>)
      : Promise.resolve(0n),
    isActive ? readPositions(state.account).catch(() => [] as Position[]) : Promise.resolve([]),
  ]);

  const [floor] = floorTuple as readonly [bigint, bigint];
  const [headroom, headroomBps] = headroomTuple as readonly [bigint, bigint];

  // The consistency score and payout verdict — the numbers a prop firm computes in private.
  const [consistencyBps, eligibility] = await Promise.all([
    publicClient.readContract({
      address: ADDR.registry, abi: registryAbi, functionName: "consistencyScore", args: [id],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: ADDR.registry, abi: registryAbi, functionName: "payoutEligibility", args: [id],
    }) as Promise<readonly [boolean, number]>,
  ]);

  return {
    id, terms, state, liveEquity, floor, headroom, headroomBps, notional, positions,
    consistencyBps,
    payoutOk: eligibility[0],
    payoutBlock: Number(eligibility[1]),
  };
}

export async function fetchActiveIds(): Promise<bigint[]> {
  const ids = await publicClient.readContract({
    address: ADDR.registry,
    abi: registryAbi,
    functionName: "activeMandates",
  });
  return [...(ids as readonly bigint[])];
}

/**
 * Every mandate id worth showing: all Active ones, the viewer's own (so a breached mandate of
 * theirs stays inspectable), and a short tail of recently settled ones for the history views.
 *
 * Replaces a loop that guessed ids 1..highest+6 and fetched each in full. Against a real RPC
 * that was ~90 calls per refresh; this is one multicall.
 */
export async function fetchRelevantIds(viewer?: Address): Promise<bigint[]> {
  const [active, mine, next] = await Promise.all([
    publicClient.readContract({address: ADDR.registry, abi: registryAbi, functionName: "activeMandates"}) as Promise<readonly bigint[]>,
    viewer
      ? (publicClient.readContract({address: ADDR.registry, abi: registryAbi, functionName: "mandatesOf", args: [viewer]}) as Promise<readonly bigint[]>)
      : Promise.resolve([] as readonly bigint[]),
    publicClient.readContract({address: ADDR.registry, abi: registryAbi, functionName: "nextMandateId"}) as Promise<bigint>,
  ]);

  const ids = new Set<bigint>([...active, ...mine]);
  // Recently settled: the last few ids that are not active. Bounded, so it never fans out.
  for (let i = next - 1n; i >= 1n && i > next - 9n; i--) ids.add(i);
  return [...ids].sort((a, b) => (a < b ? -1 : 1));
}

export async function fetchPoolStats(): Promise<PoolStats> {
  const [totalAssets, idle, allocated, pricePerShare, utilisationBps] = await Promise.all([
    publicClient.readContract({address: ADDR.pool, abi: poolAbi, functionName: "totalAssets"}),
    publicClient.readContract({address: ADDR.pool, abi: poolAbi, functionName: "idleAssets"}),
    publicClient.readContract({address: ADDR.pool, abi: poolAbi, functionName: "totalAllocated"}),
    publicClient.readContract({address: ADDR.pool, abi: poolAbi, functionName: "pricePerShare"}),
    publicClient.readContract({address: ADDR.pool, abi: poolExtraAbi, functionName: "utilisationBps"}),
  ]);
  return {
    totalAssets: totalAssets as bigint,
    idle: idle as bigint,
    allocated: allocated as bigint,
    pricePerShare: pricePerShare as bigint,
    utilisationBps: utilisationBps as bigint,
  };
}

/**
 * Poll on an interval.
 *
 * Monad produces a block roughly every 400ms. Polling that fast from a browser is a good way
 * to be rate-limited for no benefit. The default is 4s: fast enough that the
 * distance-to-floor readout reads as live, slow enough that a public RPC does not throttle
 * us. Every read inside one tick is multicalled into a single request anyway.
 */
export function usePolled<T>(
  fn: () => Promise<T>,
  intervalMs = 4_000,
  deps: unknown[] = [],
): {data: T | undefined; error: string | undefined; refresh: () => void} {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async () => {
    if (inFlight.current) return; // never stack requests on a slow RPC
    inFlight.current = true;
    try {
      const next = await fnRef.current();
      // Functional update so a slow response that lands after a newer one cannot clobber it
      // with older data — another source of visible flicker on a public RPC.
      setData(() => next);
      setError(undefined);
    } catch (e) {
      // Keep whatever we last had. A blank screen is not a better answer than a stale one.
      setError(String(e).slice(0, 200));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void run();
    const t = setInterval(() => void run(), intervalMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, run, ...deps]);

  return {data, error, refresh: () => void run()};
}

/**
 * Age of the BTC price feed in seconds, per the chain's own clock. Undefined until known.
 *
 * Every trading path reverts on a stale feed, so anything that submits an order should
 * disable itself well before the cutoff rather than let the user sign a transaction the
 * contract is certain to refuse.
 */
export function useFeedAge(): number | undefined {
  const {data} = usePolled(async () => {
    const [[, publishedAt], block] = await Promise.all([
      publicClient.readContract({
        address: ADDR.oracle, abi: oracleAbi, functionName: "price", args: [16],
      }) as Promise<readonly [bigint, bigint]>,
      publicClient.getBlock({blockTag: "latest"}),
    ]);
    return Number(block.timestamp - publishedAt);
  }, 10_000);
  return data;
}

/** The live deployment's staleness bound. Trades disable a little before it. */
export const FEED_STALE_AT = 600;

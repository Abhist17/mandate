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
    highWaterMark: field<bigint>(t, "highWaterMark", 2),
    dayStartEquity: field<bigint>(t, "dayStartEquity", 3),
    dayStartBalance: field<bigint>(t, "dayStartBalance", 4),
    dayStartTime: field<bigint>(t, "dayStartTime", 5),
    lastMarkedEquity: field<bigint>(t, "lastMarkedEquity", 6),
    lastMarkedAt: field<bigint>(t, "lastMarkedAt", 7),
    issuedAt: field<bigint>(t, "issuedAt", 8),
    largestDailyGain: field<bigint>(t, "largestDailyGain", 9),
    profitableDays: Number(field(t, "profitableDays", 10)),
    tradingDays: Number(field(t, "tradingDays", 11)),
    status: Number(field(t, "status", 12)),
    breachKind: Number(field(t, "breachKind", 13)),
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
    isActive ? readPositions(state.account) : Promise.resolve([]),
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
 * to be rate-limited for no benefit, so the default is 2s — fast enough that the
 * distance-to-floor readout is live, slow enough to be a good citizen.
 */
export function usePolled<T>(
  fn: () => Promise<T>,
  intervalMs = 2_000,
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
      setData(await fnRef.current());
      setError(undefined);
    } catch (e) {
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

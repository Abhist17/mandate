/**
 * Envio HyperIndex handlers for Mandate. HyperIndex V3.
 *
 * Every handler is bookkeeping over events the contracts already emit — the contracts were
 * written with this in mind (SPEC §Phase 2: "events on every state transition, the indexer
 * depends on these"), so nothing here re-derives protocol state from contract calls.
 *
 * The only real logic is `effectiveFloor` and `headroom` on each mark. Both are pure
 * functions of values the event already carries, so computing them at index time means the
 * chart does not have to.
 *
 * V3 note: handlers register through `indexer.onEvent({contract, event}, fn)`, and entities
 * live directly on `context` (`context.Mandate.set`), not under `context.chain` — `chain` is
 * only `{id, isRealtime}`. Confirmed against the generated types rather than the docs.
 */

import {indexer} from "envio";

const GLOBAL = "global";

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

const EMPTY_STATS = {
  id: GLOBAL,
  mandatesIssued: 0,
  mandatesActive: 0,
  mandatesBreached: 0,
  mandatesSettled: 0,
  totalMarks: 0,
  totalAllocated: 0n,
  totalTraderPayouts: 0n,
  totalPoolReturns: 0n,
  lastUpdated: 0n,
};

// ─────────────────────────────────────────────────────────────────────────────
//  Registry
// ─────────────────────────────────────────────────────────────────────────────

indexer.onEvent({contract: "MandateRegistry", event: "MandateIssued"}, async ({event, context}) => {
  const id = event.params.mandateId.toString();

  context.Mandate.set({
    id,
    mandateId: event.params.mandateId,
    trader: event.params.trader,
    account: event.params.account,
    allocation: event.params.allocation,
    maxDrawdownBps: Number(event.params.maxDrawdownBps),
    dailyLossBps: Number(event.params.dailyLossBps),
    profitSplitBps: Number(event.params.profitSplitBps),
    maxPositionBps: Number(event.params.maxPositionBps),
    expiry: event.params.expiry,
    issuedAt: BigInt(event.block.timestamp),
    issuedTx: event.transaction.hash,
    status: 1, // Active
    breachKind: 0,
    // A mandate opens holding exactly its allocation, so equity and peak start there.
    currentEquity: event.params.allocation,
    highWaterMark: event.params.allocation,
    currentFloor: 0n,
    markCount: 0,
    lastMarkedAt: BigInt(event.block.timestamp),
    finalEquity: undefined,
    traderPayout: undefined,
    poolReturn: undefined,
    settledAt: undefined,
    settledTx: undefined,
  });

  const s = (await context.ProtocolStats.get(GLOBAL)) ?? EMPTY_STATS;
  context.ProtocolStats.set({
    ...s,
    mandatesIssued: s.mandatesIssued + 1,
    mandatesActive: s.mandatesActive + 1,
    totalAllocated: s.totalAllocated + event.params.allocation,
    lastUpdated: BigInt(event.block.timestamp),
  });
});

indexer.onEvent({contract: "MandateRegistry", event: "EquityMarked"}, async ({event, context}) => {
  const mandateId = event.params.mandateId.toString();

  // The binding constraint is whichever floor is higher — that is what RiskEngine.evaluate
  // compares against, and what the trader's headroom readout must reflect.
  const effectiveFloor = max(event.params.trailingFloor, event.params.dailyFloor);
  const headroom =
    event.params.equity > effectiveFloor ? event.params.equity - effectiveFloor : 0n;

  context.EquityMark.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    mandate_id: mandateId,
    mandateId: event.params.mandateId,
    equity: event.params.equity,
    highWaterMark: event.params.highWaterMark,
    trailingFloor: event.params.trailingFloor,
    dailyFloor: event.params.dailyFloor,
    effectiveFloor,
    headroom,
    netPnl: event.params.netPnl,
    markedAt: event.params.markedAt,
    blockNumber: BigInt(event.block.number),
    txHash: event.transaction.hash,
    markedBy: event.params.by,
  });

  const mandate = await context.Mandate.get(mandateId);
  if (mandate) {
    context.Mandate.set({
      ...mandate,
      currentEquity: event.params.equity,
      highWaterMark: event.params.highWaterMark,
      currentFloor: effectiveFloor,
      markCount: mandate.markCount + 1,
      lastMarkedAt: event.params.markedAt,
    });
  }

  const s = (await context.ProtocolStats.get(GLOBAL)) ?? EMPTY_STATS;
  context.ProtocolStats.set({
    ...s,
    totalMarks: s.totalMarks + 1,
    lastUpdated: BigInt(event.block.timestamp),
  });
});

indexer.onEvent({contract: "MandateRegistry", event: "DayRolled"}, async ({event, context}) => {
  // A rollover resets the daily floor's base, which shows on the chart as a step in the floor
  // line and is otherwise unexplained.
  context.PoolEvent.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    kind: "day-rolled",
    lp: undefined,
    assets: event.params.dayStartEquity,
    shares: undefined,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });
});

indexer.onEvent({contract: "MandateRegistry", event: "Breached"}, async ({event, context}) => {
  const mandateId = event.params.mandateId.toString();
  const mandate = await context.Mandate.get(mandateId);

  context.Breach.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    mandateId: event.params.mandateId,
    trader: mandate?.trader ?? "",
    kind: Number(event.params.kind),
    equityAtBreach: event.params.equityAtBreach,
    floor: event.params.floor,
    enforcedBy: event.params.enforcedBy,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });

  if (mandate) {
    context.Mandate.set({...mandate, breachKind: Number(event.params.kind)});
  }

  const s = (await context.ProtocolStats.get(GLOBAL)) ?? EMPTY_STATS;
  context.ProtocolStats.set({
    ...s,
    mandatesBreached: s.mandatesBreached + 1,
    lastUpdated: BigInt(event.block.timestamp),
  });
});

indexer.onEvent({contract: "MandateRegistry", event: "Settled"}, async ({event, context}) => {
  const mandateId = event.params.mandateId.toString();
  const mandate = await context.Mandate.get(mandateId);

  context.Settlement.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    mandateId: event.params.mandateId,
    trader: mandate?.trader ?? "",
    finalStatus: Number(event.params.finalStatus),
    finalEquity: event.params.finalEquity,
    traderPayout: event.params.traderPayout,
    poolReturn: event.params.poolReturn,
    allocation: mandate?.allocation ?? 0n,
    poolPnl: event.params.poolReturn - (mandate?.allocation ?? 0n),
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });

  if (mandate) {
    context.Mandate.set({
      ...mandate,
      status: Number(event.params.finalStatus),
      finalEquity: event.params.finalEquity,
      traderPayout: event.params.traderPayout,
      poolReturn: event.params.poolReturn,
      settledAt: BigInt(event.block.timestamp),
      settledTx: event.transaction.hash,
    });
  }

  const s = (await context.ProtocolStats.get(GLOBAL)) ?? EMPTY_STATS;
  context.ProtocolStats.set({
    ...s,
    mandatesActive: Math.max(0, s.mandatesActive - 1),
    mandatesSettled: s.mandatesSettled + 1,
    totalTraderPayouts: s.totalTraderPayouts + event.params.traderPayout,
    totalPoolReturns: s.totalPoolReturns + event.params.poolReturn,
    lastUpdated: BigInt(event.block.timestamp),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Venue — fill history
// ─────────────────────────────────────────────────────────────────────────────

indexer.onEvent({contract: "MiniPerp", event: "PositionOpened"}, async ({event, context}) => {
  context.Fill.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    account: event.params.account,
    marketId: Number(event.params.marketId),
    kind: "open",
    isLong: event.params.isLong,
    size: event.params.size,
    price: event.params.fillPrice,
    notional: event.params.notional,
    margin: event.params.margin,
    fee: event.params.fee,
    realisedPnl: undefined,
    funding: undefined,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });
});

indexer.onEvent({contract: "MiniPerp", event: "PositionClosed"}, async ({event, context}) => {
  context.Fill.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    account: event.params.account,
    marketId: Number(event.params.marketId),
    kind: "close",
    isLong: undefined,
    size: event.params.size,
    price: event.params.fillPrice,
    notional: undefined,
    margin: undefined,
    fee: event.params.fee,
    realisedPnl: event.params.realisedPnl,
    funding: event.params.funding,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });
});

indexer.onEvent({contract: "MiniPerp", event: "Flattened"}, async ({event, context}) => {
  // A flatten IS the enforcement action. Recorded separately from the individual closes so
  // the demo can point at one row and say "this is the contract doing it".
  context.PoolEvent.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    kind: "flattened",
    lp: event.params.by,
    assets: event.params.positionsClosed,
    shares: undefined,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });
});

indexer.onEvent({contract: "MiniPerp", event: "Liquidated"}, async ({event, context}) => {
  context.Fill.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    account: event.params.account,
    marketId: Number(event.params.marketId),
    kind: "liquidation",
    isLong: undefined,
    size: 0n,
    price: 0n,
    notional: undefined,
    margin: undefined,
    fee: undefined,
    realisedPnl: event.params.realisedPnl,
    funding: undefined,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Pool
// ─────────────────────────────────────────────────────────────────────────────

indexer.onEvent({contract: "CapitalPool", event: "Deposited"}, async ({event, context}) => {
  context.PoolEvent.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    kind: "deposit",
    lp: event.params.lp,
    assets: event.params.assets,
    shares: event.params.shares,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });
});

indexer.onEvent({contract: "CapitalPool", event: "WithdrawalClaimed"}, async ({event, context}) => {
  context.PoolEvent.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    kind: "withdrawal",
    lp: event.params.lp,
    assets: event.params.assets,
    shares: event.params.shares,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });
});

indexer.onEvent({contract: "CapitalPool", event: "Allocated"}, async ({event, context}) => {
  context.PoolEvent.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    kind: "allocation",
    lp: event.params.account,
    assets: event.params.amount,
    shares: undefined,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });
});

indexer.onEvent({contract: "CapitalPool", event: "MandateSettled"}, async ({event, context}) => {
  context.PoolEvent.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    kind: "settlement",
    lp: undefined,
    assets: event.params.poolReturn,
    shares: undefined,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });
});

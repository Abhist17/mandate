"use client";

import {parseAbiItem, parseEventLogs, type Address} from "viem";
import {ADDR, publicClient} from "./chain";
import {walkRegistryLogs} from "./logs";

/**
 * The public tape of the protocol: every mandate funded, every breach, every bounty paid.
 *
 * A prop firm cannot publish this. Its accounts, its breaches and the decisions behind them
 * are private records. Here each line is a log anyone can read from the registry — this page
 * is just a place to watch them arrive.
 */

const issued = parseAbiItem(
  "event MandateIssued(uint256 indexed mandateId, address indexed trader, address indexed account, uint256 allocation, uint16 maxDrawdownBps, uint16 dailyLossBps, uint16 profitSplitBps, uint16 maxPositionBps, uint64 expiry)",
);
const breached = parseAbiItem(
  "event Breached(uint256 indexed mandateId, uint8 kind, uint256 equityAtBreach, uint256 floor, address indexed enforcedBy)",
);
const bountyPaid = parseAbiItem(
  "event EnforcementBountyPaid(uint256 indexed mandateId, address indexed enforcer, uint256 amount)",
);

export type FeedEvent = {
  key: string;
  kind: "funded" | "breached";
  mandateId: bigint;
  block: bigint;
  at: number; // unix seconds, 0 if unknown
  tx: string;
  who: Address; // trader for funded, enforcer for breached
  amount: bigint; // allocation for funded, bounty for breached
  rule?: number;
  equity?: bigint;
  floor?: bigint;
};

export type FeedTotals = {enforcements: number; bountiesPaid: bigint; funded: number};

export async function fetchFeed(windows = 40n): Promise<{events: FeedEvent[]; totals: FeedTotals}> {
  const registry = ADDR.registry as Address;
  // One pass over the registry's logs, decoded locally into the three events the tape shows —
  // a third of the requests of walking each event separately, on an RPC that caps each
  // request at 100 blocks.
  const raw = await walkRegistryLogs(registry, windows);
  const iss = parseEventLogs({abi: [issued], logs: raw, strict: true});
  const br = parseEventLogs({abi: [breached], logs: raw, strict: true});
  const bp = parseEventLogs({abi: [bountyPaid], logs: raw, strict: true});

  const bountyByTx = new Map<string, bigint>();
  for (const l of bp) bountyByTx.set(`${l.transactionHash}-${l.args.mandateId}`, l.args.amount ?? 0n);

  const events: FeedEvent[] = [
    ...iss.map((l) => ({
      key: `${l.transactionHash}-${l.logIndex}`,
      kind: "funded" as const,
      mandateId: l.args.mandateId ?? 0n,
      block: l.blockNumber ?? 0n,
      at: 0,
      tx: l.transactionHash ?? "",
      who: (l.args.trader ?? "0x") as Address,
      amount: l.args.allocation ?? 0n,
    })),
    ...br.map((l) => ({
      key: `${l.transactionHash}-${l.logIndex}`,
      kind: "breached" as const,
      mandateId: l.args.mandateId ?? 0n,
      block: l.blockNumber ?? 0n,
      at: 0,
      tx: l.transactionHash ?? "",
      who: (l.args.enforcedBy ?? "0x") as Address,
      amount: bountyByTx.get(`${l.transactionHash}-${l.args.mandateId}`) ?? 0n,
      rule: Number(l.args.kind ?? 0),
      equity: l.args.equityAtBreach,
      floor: l.args.floor,
    })),
  ].sort((a, b) => Number(b.block - a.block));

  // Timestamps for the newest rows only — one block read each is the cost.
  const recent = events.slice(0, 24);
  const blocks = [...new Set(recent.map((e) => e.block))];
  const times = new Map<bigint, number>();
  await Promise.all(
    blocks.map((b) =>
      publicClient
        .getBlock({blockNumber: b})
        .then((blk) => times.set(b, Number(blk.timestamp)))
        .catch(() => undefined),
    ),
  );
  for (const e of recent) e.at = times.get(e.block) ?? 0;

  return {
    events: recent,
    totals: {
      enforcements: br.length,
      bountiesPaid: bp.reduce((s, l) => s + (l.args.amount ?? 0n), 0n),
      funded: iss.length,
    },
  };
}

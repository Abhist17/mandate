"use client";

import type {AbiEvent, Address, GetLogsReturnType} from "viem";
import {publicClient} from "./chain";

/**
 * Reading event history off a public RPC that will not give you event history.
 *
 * Monad's public RPC caps `eth_getLogs` at a **100-block range** — verified against
 * https://testnet-rpc.monad.xyz, where a 1000-block request errors with "eth_getLogs is
 * limited to a 100 range". At ~400ms blocks that is forty seconds. Anything that wants more
 * than forty seconds of the past has to walk backwards a hundred blocks at a time.
 *
 * So this exists, and everything that needs history uses it. It is a fallback, not a plan:
 * the Envio indexer removes the limit entirely and each caller should prefer it. This is
 * what keeps the app working for someone who clones the repo with nothing but an RPC URL.
 */

/** The hard cap the public RPC enforces on a single getLogs span. */
export const RPC_MAX_LOG_SPAN = 100n;

/** Windows fetched at once. Enough to be quick, few enough not to trip rate limits. */
const CONCURRENCY = 6;

/**
 * Walk back from head in 100-block windows, collecting matching logs.
 *
 * @param windows How many 100-block windows to walk. 40 is ~25 minutes at 400ms blocks —
 *   enough for a meaningful curve without firing hundreds of requests from a browser.
 */
export async function walkLogs<E extends AbiEvent>(opts: {
  address: Address;
  event: E;
  args?: Record<string, unknown>;
  windows?: bigint;
}): Promise<GetLogsReturnType<E>> {
  const {address, event, args, windows = 40n} = opts;

  const head = await publicClient.getBlockNumber();
  const span = RPC_MAX_LOG_SPAN * windows;
  const earliest = head > span ? head - span : 0n;

  const ranges: {from: bigint; to: bigint}[] = [];
  for (let to = head; to > earliest; ) {
    const from = to > earliest + RPC_MAX_LOG_SPAN ? to - RPC_MAX_LOG_SPAN + 1n : earliest;
    ranges.push({from, to});
    if (from === earliest) break;
    to = from - 1n;
  }

  const collected: unknown[] = [];
  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    const results = await Promise.all(
      ranges.slice(i, i + CONCURRENCY).map((w) =>
        publicClient
          .getLogs({
            address,
            event,
            ...(args ? {args} : {}),
            fromBlock: w.from,
            toBlock: w.to,
            // viem's getLogs overloads resolve `args` against a literal event type, which a
            // generic wrapper cannot supply. The shape is correct; only the inference is not.
          } as Parameters<typeof publicClient.getLogs>[0])
          // A single failed window must not lose the whole history.
          .catch(() => []),
      ),
    );
    for (const logs of results) collected.push(...logs);
  }

  // Windows are walked newest-first and resolve out of order, so sort before returning.
  return (collected as GetLogsReturnType<E>).sort((a, b) =>
    Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) ||
    Number((a.logIndex ?? 0) - (b.logIndex ?? 0)),
  );
}

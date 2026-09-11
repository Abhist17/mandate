"use client";

import {publicClient, ADDR, isConfigured} from "@/lib/chain";
import {oracleAbi} from "@/lib/abi";
import {usePolled} from "@/lib/data";

/**
 * Is trading actually possible right now?
 *
 * Every order and every enforcement calls priceNoOlderThan. When the feed is older than the
 * oracle's staleness bound, every one of them reverts — and from the user's side that looks
 * like a broken app: they click Long, a wallet prompt appears, and nothing changes.
 *
 * A stale feed is a system state, not a user error, and it needs to be announced at the top
 * of the page in plain language, with the age and the cause. It was not, and the first real
 * tester spent twenty minutes thinking the site was broken.
 */
export function FeedStatus() {
  const {data} = usePolled(async () => {
    if (!isConfigured) return undefined;
    const [[, publishedAt], block] = await Promise.all([
      publicClient.readContract({
        address: ADDR.oracle, abi: oracleAbi, functionName: "price", args: [16],
      }) as Promise<readonly [bigint, bigint]>,
      publicClient.getBlock({blockTag: "latest"}),
    ]);
    // Staleness is measured against the chain's clock, because that is what the contract uses.
    const ageSeconds = Number(block.timestamp - publishedAt);
    return {ageSeconds};
  }, 10_000);

  if (!data) return null;

  // The live deployment's bound is 600s; the fork's is 60s. Warn well before either, since
  // the keeper refreshes on a schedule and a warning that fires at the exact cutoff is a
  // warning that fires after the trade already failed.
  const STALE_AT = 600;
  const WARN_AT = 420;
  if (data.ageSeconds < WARN_AT) return null;

  const stale = data.ageSeconds >= STALE_AT;
  const mins = Math.floor(data.ageSeconds / 60);

  return (
    <div
      role="alert"
      className={`rounded-xl border px-4 py-3 ${
        stale
          ? "border-down/40 bg-down/[0.08] shadow-glow-down"
          : "border-warn/35 bg-warn/[0.07]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`h-2 w-2 rounded-full ${stale ? "animate-pulse bg-down" : "bg-warn"}`} />
        <span className={`text-xs font-semibold uppercase tracking-[0.12em] ${stale ? "text-down" : "text-warn"}`}>
          {stale ? "Trading paused — price feed is stale" : "Price feed is getting old"}
        </span>
        <span className="num text-2xs text-txt-lo">last price {mins}m ago</span>
      </div>
      <p className="mt-1.5 max-w-3xl text-2xs leading-relaxed text-txt-mid">
        {stale ? (
          <>
            Every order and every enforcement checks the price is fresh first, and right now it
            is not — so{" "}
            <span className="text-txt-hi">
              any trade you send will be refused by the contract, not filled.
            </span>{" "}
            This is not something you did. The keeper that relays prices has stopped, usually
            because its wallet ran out of gas. Positions and balances are safe; nothing can be
            enforced against a stale price either.
          </>
        ) : (
          <>The keeper should refresh it shortly. If this turns red, trading pauses until it does.</>
        )}
      </p>
    </div>
  );
}

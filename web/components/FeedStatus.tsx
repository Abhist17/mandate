"use client";

import {isConfigured} from "@/lib/chain";
import {usePolled, useFeed, feedCutoff, feedWarnAt} from "@/lib/data";

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
type Status = {
  checkedAt: string;
  feedAgeSeconds: number;
  keeperBalanceMon: number;
  lowGas: boolean;
  problems: string[];
  healthy: boolean;
};

export function FeedStatus() {
  // Written by scripts/supervise.sh. It knows things the browser cannot — whether the keeper
  // process is alive, how much gas its wallet has left — so when it is present it explains
  // the cause rather than leaving the page to infer one from a stale timestamp.
  const {data: status} = usePolled(async () => {
    try {
      const res = await fetch("/status.json", {cache: "no-store"});
      if (!res.ok) return null;
      const s = (await res.json()) as Status;
      // Ignore a status file nobody has refreshed in an hour; a stale report is worse than none.
      const age = Date.now() - Date.parse(s.checkedAt);
      return Number.isFinite(age) && age < 3_600_000 ? s : null;
    } catch {
      return null;
    }
  }, 30_000);

  // Same source, same thresholds as the trade button — so the banner and the button can
  // never disagree about whether trading is paused. Both come from the contracts' own bound.
  const feed = useFeed();
  if (!isConfigured || !feed) return null;
  const data = {ageSeconds: feed.age};
  const STALE_AT = feedCutoff(feed.limit);
  const WARN_AT = feedWarnAt(feed.limit);
  if (data.ageSeconds < WARN_AT) return null;

  const stale = data.ageSeconds >= STALE_AT;
  // Seconds under two minutes: against a sixty-second bound, "0m ago" says nothing.
  const ago = data.ageSeconds < 120 ? `${Math.floor(data.ageSeconds)}s` : `${Math.floor(data.ageSeconds / 60)}m`;

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
        <span className="num text-2xs text-txt-lo">last price {ago} ago</span>
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

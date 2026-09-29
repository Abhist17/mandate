"use client";

import Link from "next/link";
import {useInView} from "@/lib/motion";
import {fetchActiveIds, fetchMandate, usePolled, type Mandate} from "@/lib/data";
import {fetchBountyBps} from "@/lib/enforce";
import {fetchFeed} from "@/lib/feed";
import {isConfigured} from "@/lib/chain";
import {fmtUsd} from "@/lib/format";
import {CountUp} from "@/components/motion";

/**
 * The enforcement market, live, on the front page.
 *
 * Real mandates from the chain, closest to their floor first, with the bounty rate the
 * registry pays and what it has paid so far. Polls only while on screen, and loads as its
 * own chunk so the hero never waits for it.
 */
export function EnforcementPreview() {
  const [ref, visible] = useInView<HTMLDivElement>({once: false, threshold: 0, rootMargin: "200px"});

  const {data: rows} = usePolled(
    async () => {
      if (!visible || !isConfigured) return undefined;
      const ids = await fetchActiveIds();
      const all = await Promise.all(ids.map((id) => fetchMandate(id).catch(() => undefined)));
      return (all.filter(Boolean) as Mandate[]).sort((a, b) => Number(a.headroomBps - b.headroomBps)).slice(0, 4);
    },
    8_000,
    [visible],
  );
  const {data: bps} = usePolled(async () => (visible && isConfigured ? fetchBountyBps() : undefined), 60_000, [visible]);
  const {data: feed} = usePolled(async () => (visible && isConfigured ? fetchFeed(20n) : undefined), 20_000, [visible]);

  return (
    <div ref={ref} className="overflow-hidden rounded-xl border border-edge bg-ink-900 shadow-panel-lg">
      <div className="flex items-center justify-between border-b border-edge px-4 py-3">
        <span className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.16em] text-txt-hi">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-up" />
          Bounty board · live
        </span>
        <span className="num text-2xs text-txt-lo">
          {bps !== undefined ? `${(bps / 100).toFixed(2)}% of allocation to the enforcer` : "—"}
        </span>
      </div>

      <div className="divide-y divide-edge/60">
        {(rows ?? Array.from({length: 3}).map(() => undefined)).map((m, i) => (
          <div key={m?.id.toString() ?? i} className="flex items-center gap-3 px-4 py-2.5 text-xs">
            {m ? (
              <>
                <span className="num w-8 text-txt-hi">#{m.id.toString()}</span>
                <span className="num w-28 text-right text-txt-mid">{fmtUsd(m.liveEquity)}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-800">
                  <div
                    className={`h-full rounded-full transition-[width] duration-700 ${
                      m.liveEquity < m.floor ? "bg-down" : Number(m.headroomBps) < 150 ? "bg-down" : Number(m.headroomBps) < 400 ? "bg-warn" : "bg-up"
                    }`}
                    style={{width: `${m.liveEquity < m.floor ? 100 : Math.max(3, Math.min(100, Number(m.headroomBps) / 5))}%`}}
                  />
                </div>
                <span className={`num w-24 text-right text-2xs ${m.liveEquity < m.floor ? "text-down" : "text-txt-lo"}`}>
                  {m.liveEquity < m.floor ? "ENFORCEABLE" : `${(Number(m.headroomBps) / 100).toFixed(2)}% room`}
                </span>
                <span className="num w-20 text-right text-2xs text-up">
                  {bps !== undefined ? `+${fmtUsd((m.terms.allocation * BigInt(bps)) / 10_000n)}` : ""}
                </span>
              </>
            ) : (
              <div className="shimmer h-4 w-full rounded" />
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-edge px-4 py-3 text-2xs">
        <span className="text-txt-lo">
          Bounties paid in the readable window:{" "}
          <span className="num text-up">
            <CountUp value={feed ? Number(feed.totals.bountiesPaid) / 1e6 : undefined} format={(n) => fmtUsd(BigInt(Math.round(n * 1e6)))} />
          </span>
        </span>
        <Link href="/enforce" className="text-acc-hi transition-colors hover:text-txt-hi">
          Open the board →
        </Link>
      </div>
    </div>
  );
}

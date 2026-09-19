"use client";

import {useEffect, useState} from "react";
import type {Address} from "viem";
import {Panel, Empty, Skeleton} from "@/components/ui";
import {fetchTrades, type Trade} from "@/lib/trades";
import {explorerTx} from "@/lib/chain";

/**
 * The journal.
 *
 * Every funded-trading dashboard has one and traders live in it — it is where you find out
 * whether the thing you believe about your own trading is true. This one is assembled from
 * the venue contract's `PositionOpened` and `PositionClosed` logs, so it is not a statement
 * the firm produced about you; it is the record, and a trade that happened cannot be absent
 * from it.
 *
 * The summary strip is the part worth arguing about. Win rate on its own flatters a trader
 * who takes tiny profits and lets losers run, so it sits next to average win and average
 * loss, which is the pairing that makes it mean something.
 */
export function TradeHistory({account}: {account: Address}) {
  const [trades, setTrades] = useState<Trade[]>();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTrades(undefined);
    fetchTrades(account)
      .then((t) => {
        if (!cancelled) setTrades(t);
      })
      .catch(() => {
        if (!cancelled) setTrades([]);
      });
    return () => {
      cancelled = true;
    };
  }, [account]);

  if (!trades) {
    return (
      <Panel title="Trade history">
        <div className="space-y-3 p-4">
          {Array.from({length: 3}).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </Panel>
    );
  }

  if (trades.length === 0) {
    return (
      <Panel title="Trade history">
        <Empty>
          No closed trades in the indexed window. Every close is a public event — this fills
          in as you trade.
        </Empty>
      </Panel>
    );
  }

  const wins = trades.filter((t) => t.realisedPnl > 0);
  const losses = trades.filter((t) => t.realisedPnl < 0);
  const avg = (rows: Trade[]) =>
    rows.length === 0 ? 0 : rows.reduce((s, t) => s + t.realisedPnl, 0) / rows.length;
  const total = trades.reduce((s, t) => s + t.realisedPnl, 0);
  const shown = expanded ? trades : trades.slice(0, 8);

  return (
    <Panel
      title="Trade history"
      right={<span className="num text-2xs text-txt-lo">{trades.length} closed</span>}
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 border-b border-edge px-4 py-4 sm:grid-cols-4">
        <Metric
          label="Win rate"
          value={`${((wins.length / trades.length) * 100).toFixed(0)}%`}
          sub={`${wins.length}W / ${losses.length}L`}
        />
        <Metric label="Average win" value={money(avg(wins))} tone="up" />
        <Metric label="Average loss" value={money(avg(losses))} tone="down" />
        <Metric
          label="Net realised"
          value={money(total)}
          tone={total >= 0 ? "up" : "down"}
          sub="after fees and funding"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-xs">
          <thead>
            <tr className="border-b border-edge text-2xs uppercase tracking-wider text-txt-lo">
              <th className="px-4 py-2 text-left font-medium">Market</th>
              <th className="px-4 py-2 text-right font-medium">Size</th>
              <th className="px-4 py-2 text-right font-medium">Entry</th>
              <th className="px-4 py-2 text-right font-medium">Exit</th>
              <th className="px-4 py-2 text-right font-medium">Held</th>
              <th className="px-4 py-2 text-right font-medium">Closed</th>
              <th className="px-4 py-2 text-right font-medium">Realised</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.key} className="row-hover border-b border-edge/50 last:border-0">
                <td className="px-4 py-2.5">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider ${
                      t.isLong ? "bg-up/10 text-up" : "bg-down/10 text-down"
                    }`}
                  >
                    {t.isLong ? "Long" : "Short"}
                  </span>
                  <span className="ml-2 text-txt-hi">{t.symbol}</span>
                  {/* The column a prop firm has no way to show: this exit was not the
                      trader's decision, it was the contract closing the book. */}
                  {t.enforced && (
                    <span
                      className="ml-2 rounded border border-down/30 bg-down/10 px-1.5 py-px text-[0.6rem] font-semibold uppercase tracking-wider text-down"
                      title="Closed by enforcement when the mandate breached, not by the trader"
                    >
                      Enforced
                    </span>
                  )}
                </td>
                <td className="num px-4 py-2.5 text-right text-txt-mid">{t.size.toLocaleString("en-US", {maximumFractionDigits: 4})}</td>
                <td className="num px-4 py-2.5 text-right text-txt-mid">{price(t.entryPrice)}</td>
                <td className="num px-4 py-2.5 text-right text-txt-hi">{price(t.exitPrice)}</td>
                <td className="num px-4 py-2.5 text-right text-txt-lo">{held(t)}</td>
                <td className="num px-4 py-2.5 text-right text-txt-lo">
                  <a
                    href={explorerTx(t.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-ink-600 underline-offset-2 transition-colors hover:text-txt-hi"
                    title={`Block ${t.closeBlock.toLocaleString()}`}
                  >
                    {t.closedAt ? new Date(t.closedAt * 1000).toLocaleTimeString("en-GB") : "—"}
                  </a>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span
                    className={`num rounded px-2 py-1 ${
                      t.realisedPnl >= 0 ? "bg-up/[0.08] text-up" : "bg-down/[0.08] text-down"
                    }`}
                  >
                    {money(t.realisedPnl)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {trades.length > 8 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full border-t border-edge py-2.5 text-2xs text-txt-lo transition-colors hover:bg-white/[0.02] hover:text-txt-hi"
        >
          {expanded ? "Show less" : `Show all ${trades.length}`}
        </button>
      )}
    </Panel>
  );
}

function Metric({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "up" | "down";
}) {
  const t = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-txt-hi";
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`figure font-mono mt-1 text-base ${t}`}>{value}</div>
      {sub && <div className="mt-0.5 text-2xs text-txt-lo">{sub}</div>}
    </div>
  );
}

const money = (n: number) =>
  `${n < 0 ? "−" : n > 0 ? "+" : ""}${Math.abs(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const price = (n: number) =>
  n === 0
    ? "—"
    : n.toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 2});

/** Time held, or a dash when the opening event fell outside the readable window. */
function held(t: Trade): string {
  if (!t.openedAt || !t.closedAt) return "—";
  const s = t.closedAt - t.openedAt;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d`;
}

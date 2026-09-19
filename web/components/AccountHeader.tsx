"use client";

import {StatusPill, Live} from "@/components/ui";
import {fmtUsd, fmtSigned, fmtPct, fmtCountdown, toNum, shortAddr} from "@/lib/format";
import {BREACH_KIND} from "@/lib/chain";
import type {Mandate} from "@/lib/data";

/**
 * The account strip every prop firm dashboard opens with.
 *
 * Balance and equity are shown separately, which is the convention and it carries real
 * information: the gap between them is what is still riding on open positions. A trader
 * reading one number cannot tell whether they are up because they closed a winner or up
 * because a position has not been closed yet — and only one of those survives the next tick.
 */
const MODE = ["static", "trailing", "trailing to breakeven"];

export function AccountHeader({mandate}: {mandate: Mandate}) {
  const {terms, state} = mandate;
  const active = state.status === 1;

  const equity = mandate.liveEquity;
  const pnl = equity - terms.allocation;
  const todayPnl = equity - state.dayStartEquity;
  const bps = Number(mandate.headroomBps);
  const tone = !active ? "neutral" : bps < 150 ? "down" : bps < 400 ? "warn" : "up";

  return (
    <section className="panel rise overflow-hidden">
      {/* identity */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="num text-sm font-semibold text-txt-hi">#{mandate.id.toString()}</span>
          <StatusPill status={state.status} />
        </div>
        <span className="num text-xs text-txt-mid">{fmtUsd(terms.allocation)}</span>
        <span className="hidden text-2xs text-txt-lo sm:inline">
          {fmtPct(terms.maxDrawdownBps)} {MODE[terms.drawdownMode]} · {fmtPct(terms.dailyLossBps)}{" "}
          daily · {terms.maxPositionBps / 10_000}x · {fmtPct(terms.profitSplitBps)} split
        </span>
        <div className="ml-auto flex items-center gap-3 text-2xs text-txt-lo">
          <span className="num">{shortAddr(state.trader)}</span>
          <span className="num">{active ? fmtCountdown(terms.expiry) : BREACH_KIND[state.breachKind]}</span>
        </div>
      </header>

      {/* the numbers */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 p-4 sm:p-5 lg:grid-cols-5">
        <Figure label="Balance" value={fmtUsd(mandate.balance)} sub="realised" />
        <Figure label="Equity" value={<Live value={fmtUsd(equity)} />} sub="incl. open positions" big />
        <Figure
          label="Distance to floor"
          value={active ? <Live value={fmtUsd(mandate.headroom)} /> : "—"}
          sub={active ? `${(bps / 100).toFixed(2)}% of equity` : BREACH_KIND[state.breachKind]}
          tone={tone}
          big
          glow={active}
        />
        <Figure
          label="Today"
          value={<Live value={fmtSigned(todayPnl)} />}
          sub={`from ${fmtUsd(state.dayStartEquity)}`}
          tone={todayPnl >= 0n ? "up" : "down"}
        />
        <Figure
          label="Total P&L"
          value={<Live value={fmtSigned(pnl)} />}
          sub={`peak ${fmtUsd(state.highWaterMark)}`}
          tone={pnl >= 0n ? "up" : "down"}
        />
      </div>

      {/* the gauge: where equity sits between the floor and the peak */}
      <div className="border-t border-edge px-4 py-3.5 sm:px-5">
        <Gauge
          equity={toNum(equity)}
          floor={toNum(mandate.floor)}
          peak={toNum(state.highWaterMark)}
          allocation={toNum(terms.allocation)}
        />
      </div>
    </section>
  );
}

function Figure({
  label, value, sub, tone = "neutral", big = false, glow = false,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: "neutral" | "up" | "down" | "warn";
  big?: boolean;
  glow?: boolean;
}) {
  const t =
    tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : "text-txt-hi";
  const g =
    glow && tone === "down" ? "drop-shadow-[0_0_16px_rgba(255,61,85,0.4)]"
    : glow && tone === "warn" ? "drop-shadow-[0_0_16px_rgba(255,180,58,0.35)]"
    : glow && tone === "up" ? "drop-shadow-[0_0_16px_rgba(0,227,155,0.32)]"
    : "";
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`figure font-mono mt-1.5 ${big ? "text-xl sm:text-2xl" : "text-base"} ${t} ${g}`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-2xs text-txt-lo">{sub}</div>}
    </div>
  );
}

/**
 * Where equity sits between the floor that kills the account and the peak the floor is
 * measured from — with the starting allocation marked, because "am I up or down on what they
 * gave me" is a different question from "how close am I to being closed out".
 */
function Gauge({
  equity, floor, peak, allocation,
}: {
  equity: number; floor: number; peak: number; allocation: number;
}) {
  const lo = Math.min(floor, equity, allocation);
  const hi = Math.max(peak, equity, allocation);
  const span = Math.max(hi - lo, 1e-9);
  const at = (v: number) => ((v - lo) / span) * 100;

  const pct = Math.max(0, Math.min(100, at(equity)));
  const allocAt = Math.max(0, Math.min(100, at(allocation)));
  const headroomPct = peak > floor ? ((equity - floor) / (peak - floor)) * 100 : 0;
  const tone = headroomPct <= 20 ? "bg-down" : headroomPct < 45 ? "bg-warn" : "bg-up";

  const money0 = (v: number) =>
    v.toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0});

  return (
    <div className="space-y-2">
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-ink-800 ring-1 ring-inset ring-white/[0.04]">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${tone}`}
          style={{width: `${pct}%`}}
        />
        {/* the allocation tick — break-even for the profit split */}
        <div
          className="absolute inset-y-0 w-px bg-white/35"
          style={{left: `${allocAt}%`}}
          title={`allocation ${money0(allocation)}`}
        />
      </div>
      <div className="flex justify-between text-2xs">
        <span className="text-down">{money0(floor)} floor</span>
        <span className="text-txt-lo">{money0(allocation)} start</span>
        <span className="text-txt-lo">{money0(peak)} peak</span>
      </div>
    </div>
  );
}

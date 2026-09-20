"use client";

import {Live} from "@/components/ui";
import {ProofChip} from "@/lib/useProof";
import {registryAbi} from "@/lib/abi";
import {ADDR} from "@/lib/chain";
import {fmtUsd, fmtSigned, toNum} from "@/lib/format";
import {BREACH_KIND} from "@/lib/chain";
import type {Mandate} from "@/lib/data";

/**
 * Current results.
 *
 * The top row is the one every funded-trading dashboard opens with — balance, equity, and
 * what is still riding on open positions — and it is that row everywhere because the gap
 * between the first two carries real information. A trader reading a single number cannot
 * tell whether they are up because they closed a winner or up because a position has not
 * been closed yet, and only one of those survives the next tick.
 *
 * The second row is the part a normal prop firm has no equivalent of. Distance to floor is
 * not a performance statistic; it is how much room is left before a contract closes the
 * account without asking anyone. So it gets the largest number on the screen.
 */
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
      <header className="panel-head">
        <h2 className="panel-title">Current results</h2>
        <span className="text-2xs text-txt-lo">
          {fmtUsd(terms.allocation)} allocated
        </span>
      </header>

      {/* the three every trader already knows how to read */}
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 px-4 py-5 sm:grid-cols-3 sm:px-5">
        <Figure label="Balance" value={fmtUsd(mandate.balance)} sub="realised" big />
        <Figure
          label="Equity"
          value={<Live value={fmtUsd(equity)} />}
          sub="incl. open positions"
          big
        />
        <Figure
          label="Unrealised P&L"
          value={<Live value={fmtSigned(mandate.floatingPnl)} />}
          sub={mandate.positions.length === 1 ? "1 open position" : `${mandate.positions.length} open positions`}
          tone={mandate.floatingPnl >= 0n ? "up" : "down"}
          big
        />
      </div>

      {/* the one a smart contract is watching */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 border-t border-edge px-4 py-5 sm:grid-cols-4 sm:px-5">
        <div className="col-span-2">
          <div className="stat-label">Distance to floor</div>
          <div
            className={`figure font-mono mt-1.5 text-3xl ${
              tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : tone === "up" ? "text-up" : "text-txt-hi"
            } ${
              active
                ? tone === "down"
                  ? "drop-shadow-[0_0_18px_rgba(255,61,85,0.4)]"
                  : tone === "warn"
                    ? "drop-shadow-[0_0_18px_rgba(255,180,58,0.35)]"
                    : "drop-shadow-[0_0_18px_rgba(0,227,155,0.3)]"
                : ""
            }`}
          >
            {active ? <Live value={fmtUsd(mandate.headroom)} /> : "—"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-2xs text-txt-lo">
            <span>{active ? `${(bps / 100).toFixed(2)}% of equity` : BREACH_KIND[state.breachKind]}</span>
            {/* The biggest number on the screen is the one most worth doubting, so it is
                the one that carries the check. */}
            <ProofChip
              spec={{
                title: "Distance to floor",
                blurb:
                  "headroom() returns how far equity sits above the floor, and the bps it works out to. The same pair markAndEnforce compares before it decides to close you.",
                address: ADDR.registry as `0x${string}`,
                abi: registryAbi as never,
                functionName: "headroom",
                args: [mandate.id],
                shown: fmtUsd(mandate.headroom),
                format: (d) => fmtUsd((d as readonly bigint[])[0]),
              }}
            />
          </div>
        </div>
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
  label,
  value,
  sub,
  tone = "neutral",
  big = false,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: "neutral" | "up" | "down" | "warn";
  big?: boolean;
}) {
  const t =
    tone === "up"
      ? "text-up"
      : tone === "down"
        ? "text-down"
        : tone === "warn"
          ? "text-warn"
          : "text-txt-hi";
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`figure font-mono mt-1.5 ${big ? "text-2xl" : "text-base"} ${t}`}>{value}</div>
      {sub && <div className="mt-1 text-2xs text-txt-lo">{sub}</div>}
    </div>
  );
}

/**
 * Where equity sits between the floor that kills the account and the peak the floor is
 * measured from — with the starting allocation marked, because "am I up or down on what
 * they gave me" is a different question from "how close am I to being closed out".
 */
function Gauge({
  equity,
  floor,
  peak,
  allocation,
}: {
  equity: number;
  floor: number;
  peak: number;
  allocation: number;
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

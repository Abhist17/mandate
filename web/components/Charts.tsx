"use client";

import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
  Scatter,
  ScatterChart,
  ZAxis,
} from "recharts";

/**
 * Charts for the pool and market screens.
 *
 * These deliberately visualise *distribution*, not history. The pages they sit on answer
 * "where is the risk right now" and "what is capital paying today", and neither needs a time
 * series to do it — a bar of every mandate's headroom tells an LP more at a glance than a TVL
 * line ever would. The equity curve on the trader screen is the one place history is the
 * point, and it lives in EquityChart.
 */

const money0 = (v: number) =>
  v.toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0});

function TinyTooltip({
  active,
  payload,
  rows,
}: {
  active?: boolean;
  payload?: {payload: Record<string, unknown>}[];
  rows: (p: Record<string, unknown>) => [string, string][];
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-edge-hi bg-ink-900/97 px-3 py-2 font-mono text-2xs shadow-xl">
      {rows(payload[0]!.payload).map(([k, v]) => (
        <div key={k} className="flex justify-between gap-5">
          <span className="text-txt-lo">{k}</span>
          <span className="text-txt-hi">{v}</span>
        </div>
      ))}
    </div>
  );
}

export type HeadroomBarDatum = {
  label: string;
  headroomBps: number;
  headroom: number;
  equity: number;
};

/**
 * Every live mandate's distance to its floor, worst first.
 *
 * This is the LP's actual question — not "how much have we made" but "who is about to blow
 * up". Sorting worst-first means the thing that matters is always in the top-left, where the
 * eye lands.
 */
export function HeadroomBars({data, height = 220}: {data: HeadroomBarDatum[]; height?: number}) {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-edge text-2xs text-txt-lo"
        style={{height}}
      >
        No live mandates.
      </div>
    );
  }

  const colour = (bps: number) => (bps < 150 ? "#ff3d55" : bps < 350 ? "#ffb43a" : "#00e39b");

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{top: 8, right: 12, bottom: 0, left: 4}}>
        <XAxis
          dataKey="label"
          stroke="#2a3140"
          tick={{fill: "#646d7e", fontSize: 10.5, fontFamily: "ui-monospace"}}
          tickLine={false}
          axisLine={{stroke: "#1a1f2a"}}
        />
        <YAxis
          tickFormatter={(v: number) => `${(v / 100).toFixed(1)}%`}
          stroke="#2a3140"
          tick={{fill: "#646d7e", fontSize: 10.5, fontFamily: "ui-monospace"}}
          tickLine={false}
          axisLine={false}
          width={48}
        />
        {/* The line below which a mandate is one bad tick from enforcement. */}
        {/* insideTopLeft, not right: at the right edge the label is clipped by the plot area. */}
        <ReferenceLine
          y={150}
          stroke="#ff3d55"
          strokeDasharray="3 3"
          label={{value: "danger", position: "insideTopLeft", fill: "#ff3d55", fontSize: 9}}
        />
        <Tooltip
          cursor={{fill: "rgba(255,255,255,0.03)"}}
          content={
            <TinyTooltip
              rows={(p) => [
                ["mandate", String(p.label)],
                ["equity", money0(Number(p.equity))],
                ["to floor", money0(Number(p.headroom))],
                ["headroom", `${(Number(p.headroomBps) / 100).toFixed(2)}%`],
              ]}
            />
          }
        />
        {/* Capped width so a pool with three mandates does not render three slabs. */}
        <Bar dataKey="headroomBps" radius={[3, 3, 0, 0]} maxBarSize={54} isAnimationActive={false}>
          {data.map((d) => (
            <Cell key={d.label} fill={colour(d.headroomBps)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export type OfferPoint = {
  id: string;
  allocation: number;
  splitPct: number;
  requirement: number; // how demanding the record requirement is, 0..n
  qualifies: boolean;
};

/**
 * The market, as a picture: allocation against profit split.
 *
 * The shape is the argument. Offers march up and to the right — bigger cheques *and* better
 * splits as the record required gets harder. A prop firm's menu would be a single dot.
 */
export function OfferScatter({data, height = 240}: {data: OfferPoint[]; height?: number}) {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-edge text-2xs text-txt-lo"
        style={{height}}
      >
        No open offers.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{top: 12, right: 20, bottom: 4, left: 4}}>
        <XAxis
          type="number"
          dataKey="allocation"
          name="allocation"
          tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
          stroke="#2a3140"
          tick={{fill: "#646d7e", fontSize: 10.5, fontFamily: "ui-monospace"}}
          tickLine={false}
          axisLine={{stroke: "#1a1f2a"}}
        />
        <YAxis
          type="number"
          dataKey="splitPct"
          name="split"
          domain={["dataMin - 6", "dataMax + 6"]}
          tickFormatter={(v: number) => `${v}%`}
          stroke="#2a3140"
          tick={{fill: "#646d7e", fontSize: 10.5, fontFamily: "ui-monospace"}}
          tickLine={false}
          axisLine={false}
          width={44}
        />
        <ZAxis type="number" dataKey="requirement" range={[80, 420]} />
        <Tooltip
          cursor={{strokeDasharray: "3 3", stroke: "#3d4657"}}
          content={
            <TinyTooltip
              rows={(p) => [
                ["allocation", money0(Number(p.allocation))],
                ["split", `${Number(p.splitPct)}% to trader`],
                ["you qualify", p.qualifies ? "yes" : "not yet"],
              ]}
            />
          }
        />
        <Scatter data={data} isAnimationActive={false}>
          {data.map((d) => (
            <Cell
              key={d.id}
              fill={d.qualifies ? "#00e39b" : "#2a3140"}
              stroke={d.qualifies ? "#00e39b" : "#3d4657"}
              fillOpacity={d.qualifies ? 0.55 : 0.3}
            />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}

/** Idle vs allocated, as one bar. Utilisation is the LP's headline number. */
export function UtilisationBar({idle, allocated}: {idle: number; allocated: number}) {
  const total = idle + allocated;
  const pct = total === 0 ? 0 : (allocated / total) * 100;
  return (
    <div className="space-y-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-ink-800 ring-1 ring-inset ring-white/[0.04]">
        <div
          className="h-full bg-up/70 transition-all duration-700"
          style={{width: `${pct}%`}}
          title="allocated"
        />
      </div>
      <div className="flex justify-between text-2xs">
        <span className="text-up">{money0(allocated)} working</span>
        <span className="text-txt-lo">{money0(idle)} idle</span>
      </div>
    </div>
  );
}

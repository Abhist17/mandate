"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {EquityPoint} from "@/lib/history";

/**
 * The screen.
 *
 * SPEC §3.7: "the equity curve with the floor on it is the screen." Everything else on the
 * trader view is supporting detail; this is the thing a funded trader actually stares at.
 *
 * Three design decisions worth stating:
 *
 *   1. **The floor is drawn as a hard line, not a shaded zone.** A trader's relationship with
 *      the drawdown limit is binary — above it you are funded, below it you are not — and a
 *      gradient would soften a boundary that is not soft.
 *
 *   2. **The area between equity and the floor is filled.** That gap *is* the product. Its
 *      shrinking is the thing to notice, and a line pair makes you compute the distance while
 *      a filled band makes you see it.
 *
 *   3. **The y-axis is not zero-based.** Zero-basing a $100k account with a $95k floor
 *      compresses the entire decision into 5% of the chart height. The axis is bounded to the
 *      region that matters, with the floor always visible.
 */

type Props = {
  points: EquityPoint[];
  allocation: number;
  breached?: boolean;
  height?: number;
};

const fmtMoney = (v: number) =>
  v.toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0});

const fmtMoney2 = (v: number) =>
  v.toLocaleString("en-US", {style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2});

const fmtTime = (t: number) =>
  new Date(t * 1000).toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"});

function ChartTooltip({active, payload}: {active?: boolean; payload?: {payload: EquityPoint}[]}) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  const gap = p.equity - p.floor;
  return (
    <div className="rounded border border-edge bg-ink-900/95 px-3 py-2 font-mono text-2xs shadow-xl backdrop-blur">
      <div className="mb-1.5 text-txt-lo">
        {new Date(p.t * 1000).toLocaleString("en-GB")} · block {p.block.toLocaleString()}
      </div>
      <Row label="Equity" value={fmtMoney2(p.equity)} className="text-txt-hi" />
      <Row label="Peak" value={fmtMoney2(p.highWaterMark)} className="text-txt-mid" />
      <Row label="Floor" value={fmtMoney2(p.floor)} className="text-down" />
      <div className="mt-1.5 border-t border-edge pt-1.5">
        <Row
          label="Headroom"
          value={gap > 0 ? fmtMoney2(gap) : "breached"}
          className={gap > 0 ? "text-up" : "text-down"}
        />
      </div>
    </div>
  );
}

function Row({label, value, className}: {label: string; value: string; className?: string}) {
  return (
    <div className="flex justify-between gap-6">
      <span className="text-txt-lo">{label}</span>
      <span className={className}>{value}</span>
    </div>
  );
}

export function EquityChart({points, allocation, breached, height = 340}: Props) {
  if (points.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded border border-edge bg-ink-900 text-sm text-txt-lo"
        style={{height}}
      >
        No marks yet — the curve appears as the keeper marks this mandate.
      </div>
    );
  }

  // Bound the axis to the region that carries the decision, with padding so neither the
  // equity line nor the floor ever sits flush against an edge.
  const lows = points.map((p) => Math.min(p.equity, p.floor));
  const highs = points.map((p) => Math.max(p.equity, p.highWaterMark));
  const lo = Math.min(...lows, allocation);
  const hi = Math.max(...highs, allocation);
  const pad = Math.max((hi - lo) * 0.12, hi * 0.002);

  const last = points[points.length - 1]!;
  const healthy = last.equity >= last.floor;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{top: 8, right: 8, bottom: 0, left: 8}}>
        <defs>
          <linearGradient id="headroomFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={healthy ? "#2ee6a8" : "#ff4d5e"} stopOpacity={0.22} />
            <stop offset="100%" stopColor={healthy ? "#2ee6a8" : "#ff4d5e"} stopOpacity={0.01} />
          </linearGradient>
        </defs>

        <CartesianGrid stroke="#1d222c" strokeDasharray="2 4" vertical={false} />

        <XAxis
          dataKey="t"
          tickFormatter={fmtTime}
          stroke="#3d4455"
          tick={{fill: "#5f6879", fontSize: 11, fontFamily: "ui-monospace"}}
          tickLine={false}
          axisLine={{stroke: "#232833"}}
          minTickGap={44}
        />
        <YAxis
          domain={[lo - pad, hi + pad]}
          tickFormatter={fmtMoney}
          stroke="#3d4455"
          tick={{fill: "#5f6879", fontSize: 11, fontFamily: "ui-monospace"}}
          tickLine={false}
          axisLine={false}
          width={72}
        />

        <Tooltip content={<ChartTooltip />} cursor={{stroke: "#3d4455", strokeDasharray: "3 3"}} />

        {/* The allocation the mandate started from — the break-even line for the split. */}
        <ReferenceLine
          y={allocation}
          stroke="#3d4455"
          strokeDasharray="4 4"
          label={{value: "allocation", position: "insideTopLeft", fill: "#5f6879", fontSize: 10}}
        />

        {/* Equity, filled down to the floor: the gap IS the product. */}
        <Area
          type="stepAfter"
          dataKey="equity"
          stroke={healthy ? "#2ee6a8" : "#ff4d5e"}
          strokeWidth={1.75}
          fill="url(#headroomFill)"
          baseLine={0}
          dot={false}
          isAnimationActive={false}
          name="Equity"
        />

        {/* The high-water mark the trailing floor is measured from. Ratchets, never falls. */}
        <Area
          type="stepAfter"
          dataKey="highWaterMark"
          stroke="#3d4455"
          strokeWidth={1}
          strokeDasharray="3 3"
          fill="none"
          dot={false}
          isAnimationActive={false}
          name="High-water mark"
        />

        {/* The floor. Hard line, no gradient: the boundary is not soft. */}
        <Area
          type="stepAfter"
          dataKey="floor"
          stroke="#ff4d5e"
          strokeWidth={1.75}
          fill="#08090b"
          fillOpacity={1}
          dot={false}
          isAnimationActive={false}
          name="Drawdown floor"
        />

        {breached && (
          <ReferenceLine
            x={last.t}
            stroke="#ff4d5e"
            strokeWidth={1}
            label={{value: "BREACH", position: "top", fill: "#ff4d5e", fontSize: 10, fontWeight: 700}}
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}

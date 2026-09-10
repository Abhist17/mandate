"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
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

/**
 * Tick format follows the span of the data, not a fixed pattern.
 *
 * Marks land ~400ms apart on Monad, so a freshly seeded mandate's whole history can sit
 * inside one minute — and an axis of six identical "03:15" labels reads as a broken chart.
 * Seconds below an hour, days above a day.
 */
function tickFormatter(spanSeconds: number) {
  if (spanSeconds < 3600) {
    return (t: number) =>
      new Date(t * 1000).toLocaleTimeString("en-GB", {
        minute: "2-digit",
        second: "2-digit",
      });
  }
  if (spanSeconds < 86_400) {
    return (t: number) =>
      new Date(t * 1000).toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"});
  }
  return (t: number) =>
    new Date(t * 1000).toLocaleDateString("en-GB", {day: "2-digit", month: "short"});
}

function ChartTooltip({active, payload}: {active?: boolean; payload?: {payload: EquityPoint}[]}) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  const gap = p.equity - p.floor;
  return (
    <div className="rounded-lg border border-edge-hi bg-ink-900/97 px-3 py-2.5 font-mono text-2xs shadow-xl backdrop-blur-sm">
      <div className="mb-2 text-txt-lo">
        {new Date(p.t * 1000).toLocaleString("en-GB")} · block {p.block.toLocaleString()}
      </div>
      <Row label="Equity" value={fmtMoney2(p.equity)} className="text-txt-hi" />
      <Row label="Peak" value={fmtMoney2(p.highWaterMark)} className="text-txt-mid" />
      <Row label="Floor" value={fmtMoney2(p.floor)} className="text-down" />
      <div className="mt-2 border-t border-edge pt-2">
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
        className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-edge bg-ink-950/50"
        style={{height}}
      >
        <span className="text-sm text-txt-mid">No marks yet</span>
        <span className="text-2xs text-txt-lo">
          The curve draws itself as the keeper marks this mandate, every block.
        </span>
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
  const span = last.t - points[0]!.t;
  const fmtTick = tickFormatter(span);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{top: 12, right: 16, bottom: 0, left: 8}}>
        <defs>
          {/* The headroom band: bright where it meets the equity line, fading toward the
              floor. Brighter than a normal area fill on purpose — this gap is the product. */}
          <linearGradient id="headroomFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={healthy ? "#00e39b" : "#ff3d55"} stopOpacity={0.34} />
            <stop offset="55%" stopColor={healthy ? "#00e39b" : "#ff3d55"} stopOpacity={0.10} />
            <stop offset="100%" stopColor={healthy ? "#00e39b" : "#ff3d55"} stopOpacity={0.015} />
          </linearGradient>
          {/* Everything below the floor is the dead zone. Tinting it red makes the floor read
              as a boundary between two states rather than as one more line on a chart. */}
          <linearGradient id="dangerFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff3d55" stopOpacity={0.13} />
            <stop offset="100%" stopColor="#ff3d55" stopOpacity={0.03} />
          </linearGradient>
          <filter id="floorGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <CartesianGrid stroke="#141822" strokeDasharray="1 5" vertical={false} />

        <XAxis
          dataKey="t"
          tickFormatter={fmtTick}
          stroke="#2a3140"
          tick={{fill: "#646d7e", fontSize: 10.5, fontFamily: "ui-monospace"}}
          tickLine={false}
          axisLine={{stroke: "#1a1f2a"}}
          minTickGap={52}
        />
        <YAxis
          domain={[lo - pad, hi + pad]}
          tickFormatter={fmtMoney}
          stroke="#2a3140"
          tick={{fill: "#646d7e", fontSize: 10.5, fontFamily: "ui-monospace"}}
          tickLine={false}
          axisLine={false}
          width={74}
        />

        <Tooltip content={<ChartTooltip />} cursor={{stroke: "#3d4657", strokeDasharray: "3 3"}} />

        {/* 1. Dead zone: everything at or below the floor. Drawn first, so the floor line
               and the equity band sit on top of it. */}
        <Area
          type="stepAfter"
          dataKey="floor"
          stroke="none"
          fill="url(#dangerFill)"
          dot={false}
          isAnimationActive={false}
          legendType="none"
        />

        {/* 2. Equity, filled down to the baseline... */}
        <Area
          type="stepAfter"
          dataKey="equity"
          stroke={healthy ? "#00e39b" : "#ff3d55"}
          strokeWidth={2}
          fill="url(#headroomFill)"
          dot={false}
          isAnimationActive={false}
          name="Equity"
        />

        {/* 3. ...then the floor repainted in the page ground, masking the equity fill below
               it. What survives is exactly the band between floor and equity — the headroom,
               which is the number the whole screen exists to show. */}
        <Area
          type="stepAfter"
          dataKey="floor"
          stroke="#ff3d55"
          strokeWidth={2.25}
          fill="#07080c"
          fillOpacity={1}
          dot={false}
          isAnimationActive={false}
          name="Drawdown floor"
          style={{filter: "url(#floorGlow)"}}
        />

        {/* The peak the trailing floor is measured from. Ratchets up, never down. */}
        <Area
          type="stepAfter"
          dataKey="highWaterMark"
          stroke="#3d4657"
          strokeWidth={1}
          strokeDasharray="2 4"
          fill="none"
          dot={false}
          isAnimationActive={false}
          name="High-water mark"
        />

        {/* Where the mandate started. Quiet — it is context, not a constraint. */}
        <ReferenceLine y={allocation} stroke="#252c3a" strokeDasharray="3 5" />

        {/* The live value, so the eye lands on "now" without hunting the right edge. */}
        <ReferenceDot
          x={last.t}
          y={last.equity}
          r={3.5}
          fill={healthy ? "#00e39b" : "#ff3d55"}
          stroke="#07080c"
          strokeWidth={2}
          isFront
        />

        {breached && (
          <ReferenceLine
            x={last.t}
            stroke="#ff3d55"
            strokeWidth={1}
            strokeDasharray="3 3"
            label={{
              value: "BREACH",
              position: "insideTopRight",
              fill: "#ff3d55",
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: 1,
            }}
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}

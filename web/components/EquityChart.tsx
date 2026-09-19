"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Customized,
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
  /** Draw the labelled constraint lines across the plot. */
  objectiveLines?: boolean;
  /** Absolute dollars, or percent of the starting allocation. */
  unit?: "abs" | "pct";
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

/**
 * A value pinned to its line, the way every trading terminal marks a price.
 *
 * Reading a constraint off a y-axis means finding the line, tracing it left, and
 * interpolating between two ticks — three operations to answer "where is my floor right
 * now". The chip answers it in place. Prop-firm dashboards all do this because the numbers
 * on these particular lines are the rules of the account, not decoration.
 */
type TagSpec = {value: number; text: string; fill: string; color: string};

/**
 * Draws the value chips against the chart's own y-scale.
 *
 * Recharts' own `label` slot was the obvious route and it does not work here: on a
 * `ReferenceLine` the injected viewBox is the whole plot area, so every chip landed at the
 * top of the chart rather than on its line, and a zero-radius `ReferenceDot` is skipped
 * before its label is ever rendered. Reading the scale out of the chart and positioning the
 * chips directly is both shorter and exact.
 */
function Tags({
  specs,
  ...chart
}: {
  specs: TagSpec[];
  yAxisMap?: Record<string, {scale: (v: number) => number}>;
  offset?: {left?: number; top?: number; width?: number; height?: number};
}) {
  const axis = Object.values(chart.yAxisMap ?? {})[0];
  const off = chart.offset ?? {};
  if (!axis?.scale || off.left === undefined || off.width === undefined) return null;

  const right = off.left + off.width;
  const top = off.top ?? 0;
  const bottom = top + (off.height ?? 0);

  // Chips are nudged apart when two lines nearly coincide, so a floor sitting just under
  // equity does not print one label on top of the other.
  const placed: number[] = [];
  const settle = (y: number) => {
    let v = Math.max(top + 8, Math.min(bottom - 8, y));
    while (placed.some((p) => Math.abs(p - v) < 16)) v += 16;
    placed.push(v);
    return v;
  };

  return (
    <g style={{pointerEvents: "none"}}>
      {specs.map((s) => {
        const raw = axis.scale(s.value);
        // The axis is scaled to the equity-and-floor band, so a reference far above it —
        // a starting allocation the account is well below, an old peak — has no position
        // on this plot. Parking its chip at the edge unmarked would put a number beside a
        // gridline it does not belong to, so the caret says "off the top of this view".
        const off = raw < top ? "▲ " : raw > bottom ? "▼ " : "";
        const y = settle(raw);
        const text = off + s.text;
        const w = text.length * 5.55 + 13;
        return (
          <g key={s.text + s.fill} opacity={off ? 0.55 : 1}>
            <rect x={right + 6} y={y - 7.5} width={w} height={15} rx={3.5} fill={s.fill} />
            <text
              x={right + 6 + w / 2}
              y={y + 3.5}
              textAnchor="middle"
              fontSize={9.5}
              fontWeight={600}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              fill={s.color}
            >
              {text}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export function EquityChart({
  points,
  allocation,
  breached,
  height = 340,
  objectiveLines = true,
  unit = "abs",
}: Props) {
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
  //
  // The high-water mark is deliberately NOT allowed to set the top. On an account that has
  // given back a run-up, the peak can sit thousands above current equity, and including it
  // compressed the entire equity-to-floor band — the one thing this chart is for — into the
  // bottom tenth of the plot. The peak is context; it gets in only if it fits.
  const lo = Math.min(...points.map((p) => Math.min(p.equity, p.floor)));
  const core = Math.max(...points.map((p) => Math.max(p.equity, p.floor)));
  const peak = Math.max(...points.map((p) => p.highWaterMark));
  // A minimum band, so an account that has barely moved does not get an axis zoomed to
  // its own rounding noise.
  const band = Math.max(core - lo, core * 0.004);
  // A reference above the data earns a place on the axis only if it nearly fits already.
  // Otherwise the top is the data's own top: stretching to *almost* reach a line that is
  // still off-screen buys empty plot and no information.
  const ceiling = core + band * 0.35;
  const refs = Math.max(allocation, peak);
  const hi = refs <= ceiling ? Math.max(core, refs) : core;
  const pad = Math.max((hi - lo) * 0.12, hi * 0.002);

  const last = points[points.length - 1]!;
  const healthy = last.equity >= last.floor;
  const span = last.t - points[0]!.t;
  const fmtTick = tickFormatter(span);

  // Percent mode reads against the capital that was actually issued, so the start line sits
  // at 0 and a -3% daily limit is -3% on the axis. Expressing it as a percent of *current*
  // equity would move the rules around as the account moves, which is the opposite of what
  // a fixed constraint is.
  const asPct = (v: number) => (allocation > 0 ? (v / allocation - 1) * 100 : 0);
  const fmtAxis =
    unit === "pct" ? (v: number) => `${asPct(v) >= 0 ? "+" : ""}${asPct(v).toFixed(1)}%` : fmtMoney;
  const fmtTagVal = (v: number) =>
    unit === "pct" ? `${asPct(v) >= 0 ? "+" : ""}${asPct(v).toFixed(2)}%` : fmtMoney(v);

  // Room on the right for the pinned value chips.
  const rightPad = objectiveLines ? 92 : 16;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{top: 14, right: rightPad, bottom: 0, left: 8}}>
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
          // Without this recharts widens the domain back out to fit every series, which
          // hands the high-water-mark line the top of the axis and flattens the equity band
          // it was bounded to protect. The peak clips instead, and its chip says so.
          allowDataOverflow
          tickFormatter={fmtAxis}
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

        {/* Where the mandate started. The one genuinely flat line on the chart. */}
        <ReferenceLine y={allocation} stroke="#39415280" strokeDasharray="3 5" />

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

        {/* Current value of each line, pinned level with the line itself. Floor and peak
            both move — a trailing drawdown is not a flat rule — so these read off the live
            series rather than being drawn as horizontals that would claim otherwise. */}
        {objectiveLines && (
          <Customized
            component={(props: object) => (
              <Tags
                {...props}
                specs={[
                  {
                    value: last.equity,
                    text: fmtTagVal(last.equity),
                    fill: healthy ? "#00e39b" : "#ff3d55",
                    color: "#04120c",
                  },
                  {value: last.floor, text: fmtTagVal(last.floor), fill: "#ff3d55", color: "#ffffff"},
                  {
                    value: allocation,
                    text: unit === "pct" ? "0.00%" : fmtMoney(allocation),
                    fill: "#e8ebf2",
                    color: "#0b0d13",
                  },
                  ...(last.highWaterMark > last.equity
                    ? [
                        {
                          value: last.highWaterMark,
                          text: fmtTagVal(last.highWaterMark),
                          fill: "#2a3140",
                          color: "#c9d1e0",
                        },
                      ]
                    : []),
                ]}
              />
            )}
          />
        )}

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

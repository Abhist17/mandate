"use client";

import {useEffect, useRef, useState} from "react";
import {
  Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, ResponsiveContainer, XAxis, YAxis,
} from "recharts";
import replay from "@/lib/replay-data.json";

/**
 * A recorded breach, played back.
 *
 * The demo cannot depend on a keeper being alive and a wallet having gas. A judge opens the
 * link at a time of their choosing, and the honest answer is that infrastructure is sometimes
 * down — so the thing the whole project is about has to be watchable regardless.
 *
 * Every number here was read from chain state after a real transaction, including the
 * enforcing transaction's hash. It is a recording, not a simulation, and the caption says so
 * rather than letting anyone assume it is live.
 */

type Frame = (typeof replay.frames)[number];

const money = (v: number) =>
  v.toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0});
const money2 = (v: number) =>
  v.toLocaleString("en-US", {style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2});

const STEP_MS = 1100;

export function Replay({autoPlay = true}: {autoPlay?: boolean}) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(autoPlay);
  const frames = replay.frames as Frame[];
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!playing) return;
    if (i >= frames.length - 1) {
      // Hold on the breach, then loop. A demo that stops on its last frame gets watched once.
      timer.current = setTimeout(() => setI(0), 4200);
      return () => clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setI((n) => n + 1), STEP_MS);
    return () => clearTimeout(timer.current);
  }, [i, playing, frames.length]);

  const shown = frames.slice(0, i + 1);
  const cur = frames[i]!;
  const breached = cur.status === "breached";
  const floor = cur.floor;

  // Fixed domain across the whole replay so the floor does not appear to move as frames
  // arrive — the entire point is that it does not move.
  const lo = Math.min(...frames.map((f) => Math.min(f.equity, f.floor)));
  const hi = Math.max(...frames.map((f) => Math.max(f.equity, f.peak)));
  const pad = (hi - lo) * 0.18;

  return (
    <div className="overflow-hidden rounded-xl border border-edge bg-ink-900 shadow-panel-lg">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className={`h-2 w-2 rounded-full ${breached ? "bg-down" : "live-dot bg-up"}`} />
          <span className="text-2xs font-semibold uppercase tracking-[0.14em] text-txt-hi">
            A real breach, recorded on chain
          </span>
        </div>
        <button
          onClick={() => setPlaying((p) => !p)}
          className="text-2xs text-txt-lo transition-colors hover:text-txt-hi"
        >
          {playing ? "pause" : "play"}
        </button>
      </div>

      {/* ── the numbers ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-4 px-4 pt-4 sm:gap-6 sm:px-5">
        <Cell label="Equity" value={money2(cur.equity)} />
        <Cell
          label="Distance to floor"
          value={breached ? "BREACHED" : money2(cur.headroom)}
          tone={breached ? "down" : cur.headroomBps < 400 ? "warn" : "up"}
          big
        />
        <Cell label="Floor" value={money2(floor)} sub="does not move" />
      </div>

      {/* ── the chart ──────────────────────────────────────────────────────── */}
      <div className="px-2 pt-3 sm:px-3">
        <ResponsiveContainer width="100%" height={190}>
          <AreaChart data={shown} margin={{top: 6, right: 12, bottom: 0, left: 4}}>
            <defs>
              {/* Always green. The band is the headroom that existed at each point, and it
                  did exist — repainting it red when the final frame breaches would be the
                  chart telling a different story than the one that happened. The breach is
                  marked at the moment it occurs instead. */}
              <linearGradient id="replayBand" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#00e39b" stopOpacity={0.30} />
                <stop offset="100%" stopColor="#00e39b" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="replayDanger" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ff3d55" stopOpacity={0.14} />
                <stop offset="100%" stopColor="#ff3d55" stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#141822" strokeDasharray="1 5" vertical={false} />
            <XAxis dataKey="t" hide />
            <YAxis domain={[lo - pad, hi + pad]} hide />
            <Area type="stepAfter" dataKey="floor" stroke="none" fill="url(#replayDanger)" isAnimationActive={false} />
            <Area
              type="stepAfter" dataKey="equity"
              stroke="#00e39b" strokeWidth={2}
              fill="url(#replayBand)" isAnimationActive={false} dot={false}
            />
            <Area
              type="stepAfter" dataKey="floor"
              stroke="#ff3d55" strokeWidth={2} fill="#0b0d13" fillOpacity={1}
              isAnimationActive={false} dot={false}
            />
            {/* The moment it crossed — the only red on the series. */}
            <ReferenceDot
              x={cur.t} y={cur.equity} r={breached ? 6 : 4}
              fill={breached ? "#ff3d55" : "#00e39b"} stroke="#0b0d13" strokeWidth={2} isFront
            />
            {breached && (
              <ReferenceLine
                x={cur.t} stroke="#ff3d55" strokeDasharray="3 3"
                label={{value: "BREACH", position: "insideTopRight", fill: "#ff3d55", fontSize: 9, fontWeight: 700, letterSpacing: 1}}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* ── the caption ────────────────────────────────────────────────────── */}
      <div className="min-h-[4.5rem] border-t border-edge px-4 py-3 sm:px-5">
        <div className="flex items-baseline gap-3">
          <span className="num text-2xs text-txt-lo">BTC {money(cur.price)}</span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-800">
            <div
              className={`h-full rounded-full transition-all duration-700 ${breached ? "bg-down" : "bg-up/70"}`}
              style={{width: `${((i + 1) / frames.length) * 100}%`}}
            />
          </div>
        </div>
        <p className={`mt-2 text-xs leading-relaxed ${breached ? "text-down" : "text-txt-mid"}`}>
          {cur.label ?? "Marked again. The floor is measured from the peak, not from here."}
        </p>
        {breached && replay.txHash && (
          <a
            href={`https://testnet.monadscan.com/tx/${replay.txHash}`}
            target="_blank" rel="noreferrer"
            className="num mt-1 inline-block text-2xs text-txt-lo underline decoration-txt-lo/40 hover:text-txt-hi"
          >
            {replay.txHash.slice(0, 18)}… ↗
          </a>
        )}
      </div>
    </div>
  );
}

function Cell({
  label, value, sub, tone = "neutral", big = false,
}: {
  label: string; value: string; sub?: string;
  tone?: "neutral" | "up" | "down" | "warn"; big?: boolean;
}) {
  const t =
    tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : "text-txt-hi";
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div
        className={`figure font-mono mt-1 tabular-nums transition-colors duration-300 ${t} ${
          big ? "text-lg sm:text-2xl" : "text-sm sm:text-lg"
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-2xs text-txt-lo">{sub}</div>}
    </div>
  );
}

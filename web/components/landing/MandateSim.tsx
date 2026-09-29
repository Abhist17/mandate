"use client";

import {useEffect, useRef, useState} from "react";
import Link from "next/link";
import {easeInOut, useFrame, useInView, usePrefersReducedMotion} from "@/lib/motion";

/**
 * Inside a mandate — a scripted session, played on a loop.
 *
 * What it shows is the part of the product a reader cannot see from a static page: the floor
 * is not a number, it is a line that ratchets up behind a winning trader and never comes back
 * down, and the contract is looking at it on every mark.
 *
 * It is scripted, and labelled as scripted. It is not approximate: every figure obeys the
 * Zero preset exactly as DemoIssuer issues it — 5% trailing drawdown that stops at breakeven,
 * 3% daily loss, 3x position cap, 95/5 split — and balance plus unrealised equals equity on
 * every tick. The script was checked against those rules before it was written down.
 *
 * One thing it deliberately does not do: stop at the floor. The contract does not hold
 * equity up; it closes the account when equity crosses. So the session comes close, the
 * floor lights, the trader cuts risk, and it recovers — and the section after this one is a
 * recording of what happens to an account that does not.
 */

const ALLOC = 100_000;
const TICK = 560;
const HOLD = 3200;

/** Equity after each mark. Balance + unrealised = equity on every row (checked). */
const EQUITY = [
  100000, 100000, 100210, 100560, 101020, 101480, 101890, 102350, 102780, 103240, 103520,
  103520, 103520, 103140, 102470, 101520, 100380, 99310, 98760, 98760, 99020, 99590, 100480,
  101300, 101620, 101620,
];
const BALANCE = [
  ...Array(11).fill(100000),
  ...Array(8).fill(103520),
  ...Array(6).fill(101140),
  101620,
] as number[];

const N = EQUITY.length;
const LOOP = (N - 1) * TICK + HOLD;
/**
 * The finished session, as a still: in the hold after the last mark, before the loop's
 * fade-out. Not the loop's last millisecond — that sits inside the fade, at 1/420 opacity, and rendered
 * the scene invisible to exactly the readers who get the still: reduced motion, no JS,
 * and crawlers.
 */
const FINAL = (N - 1) * TICK + 600;

/** Floor per tick: max(trailing = min(peak·0.95, allocation), daily = 97,000). */
const FLOOR: number[] = [];
const BINDING: ("daily" | "drawdown")[] = [];
{
  let peak = ALLOC;
  for (const e of EQUITY) {
    peak = Math.max(peak, e);
    const trailing = Math.min(peak * 0.95, ALLOC);
    const daily = ALLOC * 0.97;
    FLOOR.push(Math.max(trailing, daily));
    BINDING.push(trailing >= daily ? "drawdown" : "daily");
  }
}

type Pos = {side: "LONG"; size: string; symbol: string; entry: string; cost: number} | null;
const position = (i: number): Pos =>
  i >= 1 && i <= 10
    ? {side: "LONG", size: "1.40", symbol: "BTC", entry: "$84,600", cost: 100000}
    : i >= 12 && i <= 18
      ? {side: "LONG", size: "40", symbol: "ETH", entry: "$2,690", cost: 103520}
      : i >= 19 && i <= 24
        ? {side: "LONG", size: "20", symbol: "ETH", entry: "$2,690", cost: 101140}
        : null;

/** Share of the 3x cap in use, at entry notional. */
const exposure = (i: number) =>
  i >= 1 && i <= 10 ? 0.395 : i >= 12 && i <= 18 ? 0.359 : i >= 19 && i <= 24 ? 0.179 : 0;

const record = (i: number) => (i >= 25 ? [2, 1] : i >= 19 ? [1, 1] : i >= 11 ? [1, 0] : [0, 0]);

const EVENTS: Record<number, string> = {
  1: "openPosition  LONG 1.40 BTC · cap check ✓",
  7: "new peak — floor ratchets to $97,232.50 · binding: drawdown",
  8: "new peak — floor ratchets to $97,641.00",
  9: "new peak — floor ratchets to $98,078.00",
  10: "new peak — floor ratchets to $98,344.00",
  11: "closePosition  BTC  +$3,520.00",
  12: "openPosition  LONG 40 ETH · cap check ✓",
  16: "equity falling — the floor does not move down",
  17: "inside 1% of the floor · marked every block",
  18: "$416 above the floor · cross it and the contract closes the account",
  19: "closePosition  20 ETH  −$2,380.00 · risk halved",
  21: "back outside the warning band",
  25: "closePosition  ETH  +$480.00",
};

const usd = (n: number, dp = 2) =>
  n.toLocaleString("en-US", {style: "currency", currency: "USD", minimumFractionDigits: dp, maximumFractionDigits: dp});
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${usd(Math.abs(n))}`;
const clock = (ms: number) => {
  const s = ms / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
};

// chart geometry
const VW = 640;
const VH = 236;
const X0 = 52;
const X1 = 622;
const Y0 = 14;
const Y1 = 214;
const LO = 96_400;
const HI = 104_200;
const xAt = (i: number) => X0 + ((X1 - X0) * i) / (N - 1);
const yAt = (v: number) => Y1 - ((v - LO) / (HI - LO)) * (Y1 - Y0);

export function MandateSim() {
  const reduce = usePrefersReducedMotion();
  const [ref, inView] = useInView<HTMLDivElement>({once: false, threshold: 0.25, rootMargin: "0px"});
  const [motionOn, setMotionOn] = useState(false);
  // The server renders the finished session. With motion on, the scene is parked at the
  // start while it is still offscreen, so it can play from the beginning when it arrives.
  const [t, setT] = useState(FINAL);

  useEffect(() => {
    const on = document.documentElement.dataset.motion === "on";
    setMotionOn(on);
    if (on) setT(0);
  }, []);

  const active = motionOn && !reduce && inView;

  // ~30 fps is plenty for numbers and a line, and halves the render work. The last-set
  // time lives in a ref: a local would reset on every render and throttle nothing.
  const lastSet = useRef(-Infinity);
  useEffect(() => {
    lastSet.current = -Infinity; // the clock restarts from zero on every activation
  }, [active]);
  useFrame(active, (elapsed) => {
    if (elapsed - lastSet.current < 33) return;
    lastSet.current = elapsed;
    setT(elapsed % LOOP);
  });

  useEffect(() => {
    if (reduce) setT(FINAL);
  }, [reduce]);

  // Where we are: completed tick index, and how far into the next segment.
  const i = Math.min(N - 1, Math.floor(t / TICK));
  const sub = i >= N - 1 ? 0 : easeInOut((t % TICK) / TICK);
  const j = Math.min(N - 1, i + 1);
  const equity = EQUITY[i]! + (EQUITY[j]! - EQUITY[i]!) * sub;
  const balance = BALANCE[i]!;
  const floor = FLOOR[i]!;
  const distance = equity - floor;
  const bps = (distance / equity) * 10_000;
  const near = bps < 100;
  const tone = bps < 150 ? "text-down" : bps < 400 ? "text-warn" : "text-up";
  const pos = position(i);
  const [wins, losses] = record(i);
  const trades = wins + losses;
  const profit = Math.max(0, equity - ALLOC);
  const fadeOut = t > LOOP - 420 ? (LOOP - t) / 420 : 1;

  // The line as drawn so far, ending at the interpolated point.
  const pts: [number, number][] = [];
  for (let k = 0; k <= i; k++) pts.push([xAt(k), yAt(EQUITY[k]!)]);
  if (i < N - 1) pts.push([xAt(i) + (xAt(j) - xAt(i)) * sub, yAt(equity)]);
  const line = pts.map(([x, y], k) => `${k ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

  // The floor steps: it only ever moves at a tick, and only upwards.
  const floorPts: string[] = [];
  for (let k = 0; k <= i; k++) {
    const x = xAt(k);
    const y = yAt(FLOOR[k]!);
    if (k > 0) floorPts.push(`L ${x.toFixed(1)} ${yAt(FLOOR[k - 1]!).toFixed(1)}`);
    floorPts.push(`${k ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  const headX = pts[pts.length - 1]![0];
  floorPts.push(`L ${headX.toFixed(1)} ${yAt(floor).toFixed(1)}`);
  const floorPath = floorPts.join(" ");

  // Headroom band: equity above, floor below.
  const band =
    line +
    ` L ${headX.toFixed(1)} ${yAt(floor).toFixed(1)} ` +
    [...floorPts].reverse().map((seg) => seg.replace(/^M/, "L")).join(" ") +
    " Z";

  const tape = Object.keys(EVENTS)
    .map(Number)
    .filter((k) => k <= i)
    .slice(-3)
    .reverse();

  return (
    <div ref={ref} className="overflow-hidden rounded-xl border border-edge bg-ink-900 shadow-panel-lg" style={{opacity: fadeOut}}>
      {/* header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-edge px-4 py-3">
        <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-txt-hi">Mandate · live view</span>
        <span className="num text-2xs text-txt-lo">
          Zero preset · 5% trailing to breakeven · 3% daily · 3× cap · 95/5
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className="rounded border border-edge px-1.5 py-px text-[0.6rem] uppercase tracking-[0.12em] text-txt-lo">
            scripted
          </span>
          <span className="num flex items-center gap-1.5 text-2xs text-txt-lo">
            <span key={i} className="block-beat h-1.5 w-1.5 rounded-full bg-up" />
            mark {String(i).padStart(2, "0")} · {clock(Math.min(t, (N - 1) * TICK))}
          </span>
        </span>
      </div>

      {/* the numbers */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 border-b border-edge px-4 py-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Balance" value={usd(balance)} />
        <Stat label="Equity" value={usd(equity)} />
        <Stat
          label="Unrealised"
          value={signed(equity - balance)}
          className={equity - balance >= 0 ? "text-up" : "text-down"}
        />
        <Stat label="Distance to floor" value={usd(distance)} className={tone} sub={`${(bps / 100).toFixed(2)}% of equity`} />
        <Stat label="Win rate" value={trades ? `${Math.round((wins / trades) * 100)}%` : "—"} sub={`${wins}W / ${losses}L`} />
        <div>
          <div className="stat-label">Risk exposure</div>
          <div className="num mt-1.5 text-base text-txt-hi">{Math.round(exposure(i) * 100)}%</div>
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-ink-800">
            <div
              className="h-full rounded-full bg-acc transition-[width] duration-300 ease-out"
              style={{width: `${exposure(i) * 100}%`}}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_260px]">
        {/* chart */}
        <div className="border-b border-edge p-3 lg:border-b-0 lg:border-r">
          <svg viewBox={`0 0 ${VW} ${VH}`} className="h-auto w-full" role="img" aria-label="Equity curve over a trailing floor that ratchets up and never down">
            <defs>
              <linearGradient id="ms-band" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#00e39b" stopOpacity={near ? 0.14 : 0.24} />
                <stop offset="100%" stopColor="#00e39b" stopOpacity="0.02" />
              </linearGradient>
              {/* User space: a floor that has not ratcheted yet is a flat line, and a flat
                  line's zero-height box makes a box-relative filter region empty. */}
              <filter id="ms-glow" filterUnits="userSpaceOnUse" x="0" y="0" width={VW} height={VH}>
                <feGaussianBlur stdDeviation="3" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {[97000, 99000, 101000, 103000].map((v) => (
              <g key={v}>
                <line x1={X0} x2={X1} y1={yAt(v)} y2={yAt(v)} stroke="#141822" strokeDasharray="1 5" />
                <text x={X0 - 8} y={yAt(v) + 3} textAnchor="end" fontSize="9.5" fill="#646d7e" fontFamily="ui-monospace, monospace">
                  {(v / 1000).toFixed(0)}k
                </text>
              </g>
            ))}

            <line x1={X0} x2={X1} y1={yAt(ALLOC)} y2={yAt(ALLOC)} stroke="#39415280" strokeDasharray="3 5" />
            {/* In the axis gutter, not on the plot: the curve crosses its own starting level
                twice in this session, and a label out there sat on it both times. */}
            <text x={X0 - 8} y={yAt(ALLOC) + 3} textAnchor="end" fontSize="9" fill="#a4adbd" fontFamily="ui-monospace, monospace">
              start
            </text>

            <path d={band} fill="url(#ms-band)" />
            <path
              d={floorPath}
              fill="none"
              stroke="#ff3d55"
              strokeWidth={near ? 2.4 : 1.6}
              filter={near ? "url(#ms-glow)" : undefined}
              className={near ? "floor-alert" : undefined}
            />
            {/* The curve stays green. What lights up near the limit is the limit — the floor
                line and the live point — so the warning sits exactly where the rule is. */}
            <path d={line} fill="none" stroke="#00e39b" strokeWidth="2" strokeLinejoin="round" />
            <circle cx={headX} cy={yAt(equity)} r="3.4" fill={near ? "#ff3d55" : "#00e39b"} stroke="#0b0d13" strokeWidth="2" />

            {/* the floor's own label rides the line, and says what crossing it means once
                it matters */}
            {/* Right-aligned at the head, under the part of the floor that has stopped
                moving — to its left are the ratchet steps, and a label there sat on them. */}
            <g transform={`translate(${Math.max(headX, X0 + (near ? 300 : 190)).toFixed(1)} ${yAt(floor) + 14})`}>
              <text fontSize="9.5" fill="#ff3d55" textAnchor="end" fontFamily="ui-monospace, monospace">
                floor {usd(floor)}
                {near ? " · cross it and the account closes" : BINDING[i] === "daily" ? " · daily" : " · trailing"}
              </text>
            </g>
          </svg>
        </div>

        {/* the onchain layer */}
        <div className="divide-y divide-edge text-xs">
          <Row k="Allocated from LP vault" v={usd(ALLOC, 0)} />
          <Row k="Floor set by" v={BINDING[i] === "daily" ? "daily limit" : "trailing drawdown"} />
          <div className="px-4 py-2.5">
            <div className="flex items-baseline justify-between">
              <span className="text-txt-mid">Split if paid now</span>
              <span className="num text-txt-hi">95 / 5</span>
            </div>
            <div className="mt-2 flex h-1 w-full overflow-hidden rounded-full bg-ink-800">
              <div className="h-full bg-acc" style={{width: "95%"}} />
            </div>
            <div className="num mt-1.5 flex justify-between text-2xs">
              <span className="text-up">{usd(profit * 0.95)} trader</span>
              <span className="text-txt-lo">{usd(profit * 0.05)} LPs</span>
            </div>
          </div>
          <div className="px-4 py-2.5">
            <div className="stat-label">Open position</div>
            {pos ? (
              <div className="num mt-1.5 flex items-baseline justify-between">
                <span>
                  <span className="rounded bg-up/10 px-1 py-px text-[0.6rem] font-semibold text-up">{pos.side}</span>{" "}
                  <span className="text-txt-hi">
                    {pos.size} {pos.symbol}
                  </span>{" "}
                  <span className="text-txt-lo">@ {pos.entry}</span>
                </span>
                <span className={equity - pos.cost >= 0 ? "text-up" : "text-down"}>{signed(equity - pos.cost)}</span>
              </div>
            ) : (
              <div className="mt-1.5 text-2xs text-txt-lo">Flat.</div>
            )}
          </div>
        </div>
      </div>

      {/* the tape */}
      <div className="num space-y-1 border-t border-edge bg-ink-950/60 px-4 py-2.5 text-2xs">
        {tape.length === 0 && <div className="text-txt-lo">waiting for the first mark…</div>}
        {tape.map((k, n) => (
          <div key={k} className={`flex gap-3 ${n === 0 ? "text-txt-hi" : "text-txt-lo"}`}>
            <span className="text-txt-lo">{clock(k * TICK)}</span>
            <span className={k >= 17 && k <= 18 && n === 0 ? "text-down" : undefined}>{EVENTS[k]}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-edge px-4 py-2.5 text-2xs text-txt-lo">
        <span>
          A scripted session under real preset terms — every figure obeys the contract&rsquo;s
          rules, but these trades did not happen.
        </span>
        <Link href="/trade" className="text-acc-hi transition-colors hover:text-txt-hi">
          Open a live one →
        </Link>
      </div>
    </div>
  );
}

function Stat({label, value, sub, className = "text-txt-hi"}: {label: string; value: string; sub?: string; className?: string}) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`figure font-mono mt-1.5 text-base ${className}`}>{value}</div>
      {sub && <div className="num mt-0.5 text-2xs text-txt-lo">{sub}</div>}
    </div>
  );
}

function Row({k, v}: {k: string; v: string}) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2.5">
      <span className="text-txt-mid">{k}</span>
      <span className="num text-txt-hi">{v}</span>
    </div>
  );
}

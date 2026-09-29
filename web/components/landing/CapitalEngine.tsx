"use client";

import {useEffect, useRef, useState} from "react";
import {easeInOut, phase, useFrame, useInView, usePrefersReducedMotion} from "@/lib/motion";

/**
 * The capital engine: the whole trustless loop in one diagram.
 *
 *   LP vault ──allocate──▶ MANDATE ──fund──▶ funded trader
 *                              ◀──profit──
 *        ◀── 5% to LPs ──  split  ── 95% to trader ──▶
 *
 * Every moving element is a real step of the protocol, in the order the protocol performs
 * it: capital leaves the pool, the mandate's rules are checked, the account is funded, the
 * trader trades above a floor, profit comes back and is split by the terms. The split is
 * drawn to scale — the LP pulse is smaller because the LP share is smaller — and the terms
 * shown are the Zero preset's, exactly as DemoIssuer issues them.
 *
 * It is a diagram, not a feed, and says so underneath. One clock drives everything through
 * refs, so a frame costs no React render, and the loop stops whenever it is offscreen.
 * Its default render is a finished diagram: what reduced motion, no JS and a crawler see.
 */

const CYCLE = 7600;

const C = {
  node: "#0b0d13",
  edge: "#252c3a",
  lane: "#1a1f2a",
  acc: "#2f7dfb",
  accHi: "#5195ff",
  up: "#00e39b",
  down: "#ff3d55",
  hi: "#f2f4f8",
  mid: "#a4adbd",
  lo: "#646d7e",
};

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "Inter, ui-sans-serif, system-ui, sans-serif";

const RULES = ["drawdown ≤ 5% trailing", "daily loss ≤ 3%", "position ≤ 3× allocation"];

const LANES = {
  alloc: "M 230 160 C 300 160, 330 152, 395 152",
  fund: "M 605 152 C 670 152, 700 160, 770 160",
  profit: "M 770 240 C 705 240, 670 232, 605 232",
  toLp: "M 465 310 C 445 374, 190 374, 150 280",
  toTrader: "M 535 310 C 555 374, 810 374, 850 280",
} as const;
type Lane = keyof typeof LANES;

const TRACE =
  "M 788 228 L 800 223 L 812 226 L 824 216 L 836 219 L 848 208 L 860 211 " +
  "L 872 199 L 884 203 L 896 192 L 908 195 L 920 186 L 932 189 L 942 181";

/** Where along the trace each fill tick sits, and when it lands. */
const FILLS = [
  {at: 0.26, t: 2900},
  {at: 0.55, t: 3400},
  {at: 0.82, t: 3900},
];

const TRAIL = 46;

export function CapitalEngine() {
  const reduce = usePrefersReducedMotion();
  const [wrapRef, inView] = useInView<HTMLDivElement>({once: false, threshold: 0.05, rootMargin: "0px"});
  const [motionOn, setMotionOn] = useState(false);
  useEffect(() => setMotionOn(document.documentElement.dataset.motion === "on"), []);
  const active = inView && motionOn && !reduce;

  const lane = useRef<Partial<Record<Lane, SVGPathElement | null>>>({});
  const trail = useRef<Partial<Record<Lane, SVGPathElement | null>>>({});
  const dot = useRef<Partial<Record<Lane, SVGGElement | null>>>({});
  const len = useRef<Partial<Record<Lane | "trace", number>>>({});

  const checks = useRef<(SVGGElement | null)[]>([]);
  const fills = useRef<(SVGCircleElement | null)[]>([]);
  const trace = useRef<SVGPathElement | null>(null);
  const core = useRef<SVGRectElement | null>(null);
  const floor = useRef<SVGLineElement | null>(null);
  const split = useRef<SVGTextElement | null>(null);
  const status = useRef<SVGTextElement | null>(null);
  const tranche = useRef<SVGRectElement | null>(null);
  const ripple = useRef<SVGRectElement | null>(null);
  const payLp = useRef<SVGTextElement | null>(null);
  const payTr = useRef<SVGTextElement | null>(null);

  useEffect(() => {
    for (const k of Object.keys(LANES) as Lane[]) {
      const el = lane.current[k];
      if (el) len.current[k] = el.getTotalLength();
    }
    if (trace.current) {
      const L = trace.current.getTotalLength();
      len.current.trace = L;
      // Draw-on needs a dash exactly as long as the path: shorter shows gaps, and the SSR
      // placeholder of 1000 would read as fully drawn at every offset.
      trace.current.setAttribute("stroke-dasharray", `${L} ${L}`);
    }
  }, []);

  /** Move a pulse (and its trail) to progress p along a lane; p outside 0..1 hides it. */
  const pulse = (k: Lane, p: number) => {
    const path = lane.current[k];
    const g = dot.current[k];
    const tr = trail.current[k];
    const L = len.current[k];
    if (!path || !g || !tr || !L) return;
    if (p <= 0 || p >= 1) {
      g.setAttribute("opacity", "0");
      tr.setAttribute("opacity", "0");
      return;
    }
    const pt = path.getPointAtLength(p * L);
    g.setAttribute("transform", `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)})`);
    g.setAttribute("opacity", "1");
    tr.setAttribute("stroke-dasharray", `${TRAIL} ${L}`);
    tr.setAttribute("stroke-dashoffset", `${-(p * L - TRAIL)}`);
    tr.setAttribute("opacity", "0.7");
  };

  const setStatus = (text: string, color: string) => {
    const el = status.current;
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    el.setAttribute("fill", color);
  };

  /** The finished diagram — the frame shown when nothing should move. */
  const paintStatic = () => {
    (Object.keys(LANES) as Lane[]).forEach((k) => pulse(k, 0));
    checks.current.forEach((g) => lightCheck(g, 1));
    fills.current.forEach((f) => f?.setAttribute("opacity", "1"));
    trace.current?.setAttribute("stroke-dashoffset", "0");
    trace.current?.setAttribute("opacity", "1");
    core.current?.setAttribute("stroke", C.edge);
    tranche.current?.setAttribute("opacity", "0.55");
    ripple.current?.setAttribute("opacity", "0");
    setStatus("● SETTLED", C.up);
  };

  useEffect(() => {
    if (!active) paintStatic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useFrame(active, (elapsed) => {
    const t = elapsed % CYCLE;

    // 1. Capital leaves the pool.
    pulse("alloc", easeInOut(phase(t, 0, 900)));
    const leave = phase(t, 80, 260);
    const back = phase(t, 6250, 400);
    tranche.current?.setAttribute("opacity", String(0.55 - 0.42 * leave + 0.42 * back));

    // 2. The mandate's rules are checked, in order.
    const checking = t >= 900 && t < 1700;
    core.current?.setAttribute("stroke", checking ? C.acc : C.edge);
    [950, 1150, 1350].forEach((at, i) => {
      const reset = phase(t, 7000, 350);
      lightCheck(checks.current[i] ?? null, phase(t, at, 220) * (1 - reset));
    });

    // 3. The account is funded.
    pulse("fund", easeInOut(phase(t, 1650, 800)));

    // 4. The trader trades — above a floor.
    const L = len.current.trace ?? 0;
    const draw = easeInOut(phase(t, 2450, 1800));
    const fade = phase(t, 7000, 450);
    trace.current?.setAttribute("stroke-dashoffset", `${L * (1 - draw)}`);
    trace.current?.setAttribute("opacity", `${1 - fade}`);
    FILLS.forEach((f, i) => {
      fills.current[i]?.setAttribute("opacity", `${phase(t, f.t, 160) * (1 - fade)}`);
    });

    // 5. Profit returns and is marked against the floor.
    pulse("profit", easeInOut(phase(t, 4250, 800)));
    const marking = t >= 5050 && t < 5450;
    floor.current?.setAttribute("stroke-width", marking ? "2.4" : "1.4");
    floor.current?.setAttribute("opacity", marking ? "1" : "0.8");

    // 6. The split, drawn to scale.
    const sp = easeInOut(phase(t, 5250, 1000));
    pulse("toLp", sp);
    pulse("toTrader", sp);
    const splitting = t >= 5150 && t < 6400;
    split.current?.setAttribute("fill", splitting ? C.hi : C.mid);
    payLp.current?.setAttribute("fill", t >= 6150 && t < 7000 ? C.up : C.lo);
    payTr.current?.setAttribute("fill", t >= 6150 && t < 7000 ? C.up : C.lo);

    // 7. Settled — the core's own outline goes out once and fades. Expanding the box
    //    rather than a circle from its centre keeps the ring off the rule text inside.
    const r = phase(t, 6250, 900);
    if (ripple.current) {
      const k = 1 + 0.14 * easeInOut(r);
      ripple.current.setAttribute("transform", `translate(500 195) scale(${k.toFixed(4)}) translate(-500 -195)`);
      ripple.current.setAttribute("opacity", r > 0 && r < 1 ? `${0.55 * (1 - r)}` : "0");
    }

    if (t < 900) setStatus("● ALLOCATING", C.accHi);
    else if (t < 1650) setStatus("● CHECKING", C.accHi);
    else if (t < 2450) setStatus("● FUNDED", C.accHi);
    else if (t < 4250) setStatus("● TRADING", C.mid);
    else if (t < 5250) setStatus("● MARKING", C.mid);
    else if (t < 6250) setStatus("● SETTLING", C.up);
    else setStatus("● SETTLED", C.up);
  });

  // On a phone the whole diagram at screen width is 37% scale — 4px labels. Below `sm` it
  // keeps a legible width inside a swipeable frame instead, opened centred on the core.
  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, []);

  return (
    <div ref={wrapRef} className="relative">
      <div
        ref={scroller}
        className="overflow-x-auto [scrollbar-width:none] sm:overflow-visible [&::-webkit-scrollbar]:hidden"
      >
      <svg
        viewBox="0 0 1000 400"
        className="h-auto w-[820px] max-w-none sm:w-full"
        role="img"
        aria-label="Diagram: LP capital flows from the vault into a mandate contract, which checks drawdown, daily-loss and position rules, funds a trader, receives profit back, and splits it 95% to the trader and 5% to LPs."
      >
        <defs>
          {/* User space: the floor is a horizontal line, whose zero-height bounding box
              makes a box-relative filter region empty. */}
          <filter id="ce-glow" filterUnits="userSpaceOnUse" x="0" y="0" width="1000" height="400">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* ── lanes ─────────────────────────────────────────────────────── */}
        {(Object.keys(LANES) as Lane[]).map((k) => (
          <path
            key={k}
            ref={(el) => {
              lane.current[k] = el;
            }}
            d={LANES[k]}
            fill="none"
            stroke={C.lane}
            strokeWidth={k === "toTrader" ? 2 : 1.4}
          />
        ))}
        {(Object.keys(LANES) as Lane[]).map((k) => (
          <path
            key={`${k}-trail`}
            ref={(el) => {
              trail.current[k] = el;
            }}
            d={LANES[k]}
            fill="none"
            stroke={laneColor(k)}
            strokeWidth={k === "toTrader" ? 2.6 : k === "toLp" ? 1.2 : 1.8}
            strokeLinecap="round"
            opacity={0}
          />
        ))}

        <LaneLabel x={312} y={140} text="allocate" />
        <LaneLabel x={688} y={140} text="fund" />
        <LaneLabel x={688} y={262} text="profit" />
        <text ref={payLp} x={250} y={390} textAnchor="middle" fontFamily={MONO} fontSize={10} fill={C.lo}>
          5% → LP vault
        </text>
        <text ref={payTr} x={750} y={390} textAnchor="middle" fontFamily={MONO} fontSize={10} fill={C.lo}>
          95% → trader
        </text>

        {/* ── LP vault ──────────────────────────────────────────────────── */}
        <rect x={40} y={110} width={190} height={170} rx={12} fill={C.node} stroke={C.edge} />
        <text x={58} y={136} fontFamily={SANS} fontSize={11} fontWeight={600} letterSpacing="0.12em" fill={C.hi}>
          LP VAULT
        </text>
        <text x={58} y={152} fontFamily={MONO} fontSize={10} fill={C.lo}>
          CapitalPool
        </text>
        {Array.from({length: 6}).map((_, i) => (
          <rect
            key={i}
            ref={i === 0 ? tranche : undefined}
            x={58}
            y={170 + i * 16}
            width={154}
            height={9}
            rx={2}
            fill={C.acc}
            opacity={i === 0 ? 0.55 : 0.18 + 0.05 * (5 - i)}
          />
        ))}

        {/* ── mandate core ──────────────────────────────────────────────── */}
        <rect ref={core} x={395} y={80} width={210} height={230} rx={12} fill={C.node} stroke={C.edge} strokeWidth={1.4} />
        <text x={413} y={106} fontFamily={SANS} fontSize={12} fontWeight={600} letterSpacing="0.14em" fill={C.hi}>
          MANDATE
        </text>
        <text ref={status} x={587} y={106} textAnchor="end" fontFamily={MONO} fontSize={9} letterSpacing="0.08em" fill={C.up}>
          ● SETTLED
        </text>
        <text x={413} y={122} fontFamily={MONO} fontSize={10} fill={C.accHi}>
          markAndEnforce()
        </text>
        <line x1={413} y1={136} x2={587} y2={136} stroke={C.lane} />
        {RULES.map((rule, i) => (
          <g key={rule}>
            <text x={413} y={160 + i * 30} fontFamily={MONO} fontSize={10.5} fill={C.mid}>
              {rule}
            </text>
            <g
              ref={(el) => {
                checks.current[i] = el;
              }}
              transform={`translate(580 ${156 + i * 30})`}
            >
              <circle r={7} fill={C.up} fillOpacity={0.12} stroke={C.up} strokeWidth={1.2} />
              <path d="M -3 0 L -1 2.5 L 3.2 -2.6" fill="none" stroke={C.up} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
            </g>
          </g>
        ))}
        <text x={413} y={240} fontFamily={MONO} fontSize={9} fill={C.down}>
          floor
        </text>
        <line ref={floor} x1={413} y1={244} x2={587} y2={244} stroke={C.down} strokeWidth={1.4} opacity={0.8} filter="url(#ce-glow)" />
        <text x={413} y={272} fontFamily={MONO} fontSize={10} fill={C.lo}>
          split
        </text>
        <text ref={split} x={587} y={272} textAnchor="end" fontFamily={MONO} fontSize={11} fill={C.mid}>
          95 / 5
        </text>
        <text x={413} y={294} fontFamily={MONO} fontSize={9} fill={C.lo}>
          every mark · callable by anyone
        </text>
        <rect
          ref={ripple}
          x={395}
          y={80}
          width={210}
          height={230}
          rx={12}
          fill="none"
          stroke={C.up}
          strokeWidth={1.2}
          vectorEffect="non-scaling-stroke"
          opacity={0}
        />

        {/* ── funded trader ─────────────────────────────────────────────── */}
        <rect x={770} y={110} width={190} height={170} rx={12} fill={C.node} stroke={C.edge} />
        <text x={788} y={136} fontFamily={SANS} fontSize={11} fontWeight={600} letterSpacing="0.12em" fill={C.hi}>
          FUNDED TRADER
        </text>
        <text x={788} y={152} fontFamily={MONO} fontSize={10} fill={C.lo}>
          MandateAccount
        </text>
        <line x1={788} y1={240} x2={942} y2={240} stroke={C.down} strokeWidth={1} strokeDasharray="3 4" opacity={0.75} />
        <path
          ref={trace}
          d={TRACE}
          fill="none"
          stroke={C.up}
          strokeWidth={1.6}
          strokeLinejoin="round"
          strokeDasharray="1000"
          strokeDashoffset="0"
        />
        {FILLS.map((f, i) => (
          <circle
            key={i}
            ref={(el) => {
              fills.current[i] = el;
            }}
            cx={tracePoint(f.at).x}
            cy={tracePoint(f.at).y}
            r={2.4}
            fill={C.hi}
          />
        ))}
        <text x={788} y={264} fontFamily={MONO} fontSize={9} fill={C.lo}>
          trades above the floor
        </text>

        {/* ── pulses (drawn last, on top) ───────────────────────────────── */}
        {(Object.keys(LANES) as Lane[]).map((k) => (
          <g
            key={`${k}-dot`}
            ref={(el) => {
              dot.current[k] = el;
            }}
            opacity={0}
          >
            <circle r={k === "toTrader" ? 11 : k === "toLp" ? 5 : 8} fill={laneColor(k)} opacity={0.16} />
            <circle r={k === "toTrader" ? 4.6 : k === "toLp" ? 2.2 : 3.4} fill={laneColor(k)} />
          </g>
        ))}
      </svg>
      </div>
      {/* Edge fades and a hint, phones only: the frame scrolls, and should look like it. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-ink-980 to-transparent sm:hidden" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-ink-980 to-transparent sm:hidden" />
      <p className="mt-1 text-center text-[0.6rem] uppercase tracking-[0.16em] text-txt-lo sm:hidden">
        ← swipe to follow the loop →
      </p>
    </div>
  );
}

function laneColor(k: Lane): string {
  return k === "alloc" || k === "fund" ? C.accHi : C.up;
}

function lightCheck(g: SVGGElement | null, p: number) {
  if (!g) return;
  g.setAttribute("opacity", `${0.15 + 0.85 * p}`);
  const s = 0.7 + 0.3 * p;
  const base = g.getAttribute("transform")?.match(/translate\([^)]*\)/)?.[0] ?? "";
  g.setAttribute("transform", `${base} scale(${s.toFixed(3)})`);
}

/** The trace vertex nearest a fraction along it, so each fill tick sits on the line. */
function tracePoint(f: number): {x: number; y: number} {
  const n = TRACE.replace(/[ML]/g, "").trim().split(/\s+/).map(Number);
  const count = n.length / 2;
  const i = Math.min(count - 1, Math.round(f * (count - 1)));
  return {x: n[i * 2]!, y: n[i * 2 + 1]!};
}

function LaneLabel({x, y, text}: {x: number; y: number; text: string}) {
  return (
    <text x={x} y={y} textAnchor="middle" fontFamily={MONO} fontSize={9.5} letterSpacing="0.06em" fill={C.lo}>
      {text}
    </text>
  );
}

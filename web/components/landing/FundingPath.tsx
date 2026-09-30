"use client";

import {useEffect, useRef, useState} from "react";
import {CountUp} from "@/components/motion";
import {easeInOut, easeOut, phase, useFrame, useInView, usePrefersReducedMotion} from "@/lib/motion";

/**
 * From a starter mandate to funded capital, in four states.
 *
 * The stages are Mandate's own, not a prop firm's with the words changed. There is no
 * challenge fee and no evaluator: you take a starter mandate that needs no record, you trade
 * it under enforcement, a clean settlement makes the contract write your record, and a
 * backer's standing offer accepts that record without anyone approving it. Each stage names
 * the function that performs it.
 *
 * The last stage is the one the motion is for. No confetti: the capital line draws in from
 * the LP vault, the card's border closes, the check seals, one ring goes out and fades, and
 * the new account's numbers arrive and then hold still. It should feel like an order that
 * filled — something that simply happened because the code said it would.
 *
 * Renders the finished path; the replay button re-runs it. Under reduced motion it is
 * simply the finished state.
 */

type Stage = {
  key: string;
  label: string;
  title: string;
  fn: string;
  body: string;
};

const STAGES: Stage[] = [
  {
    key: "challenge",
    label: "Challenge",
    title: "Take a starter mandate",
    fn: "claimPreset(Zero)",
    body: "$100,000 on rules fixed at issuance. No record needed, no fee.",
  },
  {
    key: "evaluation",
    label: "Evaluation",
    title: "Trade under enforcement",
    fn: "markAndEnforce()",
    body: "Every mark is checked against the floor. Anyone can call it.",
  },
  {
    key: "verified",
    label: "Verified · onchain",
    title: "Settle clean",
    fn: "recordOf(trader)",
    body: "The contract writes your record. Nobody signs off on it.",
  },
  {
    key: "funded",
    label: "Funded",
    title: "A backer's offer accepts it",
    fn: "qualifies() → claim()",
    body: "The record meets the offer's terms, so the capital moves.",
  },
];

// The timeline, in ms from the moment the section is in view.
const ON = [150, 1100, 2250, 3400];
const CONNECT = [
  [550, 1100],
  [1650, 2250],
  [2800, 3400],
];
const CAPITAL = [3400, 3950]; // capital line draws from the vault
const BORDER = [3950, 4550]; // funded card's border closes
const SEAL = 4550;
const RIPPLE = 4600;
const METRICS = 4700;
const END = 5800;

export function FundingPath() {
  const reduce = usePrefersReducedMotion();
  const [ref, inView] = useInView<HTMLDivElement>({threshold: 0.35});
  const [motionOn, setMotionOn] = useState(false);
  const [t, setT] = useState(END);
  const [run, setRun] = useState(0);

  // The landing page shows the finished path rather than performing it. Motion here is
  // opt-in — the replay button below — so nothing moves until someone asks it to.
  useEffect(() => {
    setMotionOn(document.documentElement.dataset.motion === "on");
  }, []);

  useEffect(() => {
    if (reduce) setT(END);
  }, [reduce]);

  const playing = motionOn && !reduce && inView && t < END;
  // The frame clock restarts from zero on every activation, so elapsed is the timeline.
  useFrame(playing, (elapsed) => setT(Math.min(END, elapsed)));

  const replay = () => {
    setT(0);
    setRun((n) => n + 1);
  };

  const stageOn = ON.map((at) => t >= at);
  const seal = t >= SEAL;
  const border = easeInOut(phase(t, BORDER[0]!, BORDER[1]! - BORDER[0]!));
  const capital = easeInOut(phase(t, CAPITAL[0]!, CAPITAL[1]! - CAPITAL[0]!));
  const rail = railProgress(t);

  return (
    <div ref={ref} className="relative">
      <ol className="relative grid grid-cols-1 gap-3 lg:grid-cols-4">
        {/* The rail through the stage nodes, filling as each stage completes. Desktop only:
            stacked, the cards' own order carries the sequence. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute hidden h-px bg-edge-hi lg:block"
          style={{top: 64, left: "calc((100% - 36px) / 8)", right: "calc((100% - 36px) / 8)"}}
        >
          <div className="h-full origin-left bg-acc" style={{transform: `scaleX(${rail.fill})`}} />
          {rail.pulse !== null && (
            <span
              className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-acc-hi shadow-[0_0_12px_2px_rgba(81,149,255,0.6)]"
              style={{left: `${rail.pulse * 100}%`}}
            />
          )}
        </div>

        {STAGES.map((s, i) => {
          const on = stageOn[i]!;
          const done = i < 3 ? stageOn[i + 1]! : seal;
          const funded = i === 3;
          return (
            <li key={s.key} className="flex flex-col">
              {/* Top zone: empty for the first three, the LP vault for the last. Fixed height
                  so every card's top edge — and the rail — line up. */}
              <div className={`relative h-16 ${funded ? "flex" : "hidden lg:block"} items-start justify-center`}>
                {funded && <Vault capital={capital} active={t >= CAPITAL[0]!} />}
              </div>

              <div
                className={`relative flex-1 rounded-xl border bg-ink-900 p-4 pt-6 transition-colors duration-300 ${
                  funded
                    ? seal
                      ? "border-up/40 bg-up/[0.03]"
                      : "border-edge"
                    : on
                      ? "border-edge-hi"
                      : "border-edge"
                }`}
              >
                {/* the funded card's border, closing */}
                {funded && <ClosingBorder progress={border} />}

                <Node index={i} on={on} done={done} sealed={funded && seal} ripple={funded && t >= RIPPLE} run={run} />

                <div
                  className={`text-[0.6rem] font-semibold uppercase tracking-[0.16em] transition-colors duration-300 ${
                    done ? "text-up" : on ? "text-acc-hi" : "text-txt-lo"
                  }`}
                >
                  {s.label}
                </div>
                <div className={`mt-1 text-sm font-semibold transition-colors duration-300 ${on ? "text-txt-hi" : "text-txt-mid"}`}>
                  {s.title}
                </div>
                <div className="num mt-1 text-2xs text-acc-hi/80">{s.fn}</div>
                <p className="mt-2 text-2xs leading-relaxed text-txt-lo">{s.body}</p>

                <div className="mt-3 border-t border-edge pt-3">
                  {i === 0 && <Terms on={on} />}
                  {i === 1 && <RiskBars t={t} />}
                  {i === 2 && <Record t={t} />}
                  {i === 3 && <FundedMetrics live={t >= METRICS} />}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {motionOn && !reduce && t >= END && (
        <div className="mt-3 flex justify-end">
          <button onClick={replay} className="text-2xs text-txt-lo transition-colors hover:text-txt-hi">
            ↺ replay
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A border that draws itself closed, starting and ending at the stage node on the top edge
 * — so the loop completes exactly where the check seals.
 *
 * Built as a measured path rather than a percentage-sized rect: SVG geometry attributes do
 * not accept calc(), and a 100% rect sits half a stroke off the card's real edge.
 */
function ClosingBorder({progress}: {progress: number}) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState<{w: number; h: number} | null>(null);

  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const measure = () => setSize({w: el.offsetWidth, h: el.offsetHeight});
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const i = 0.75; // half the stroke, so it sits on the card's own 1px border
  const r = 12 - i;
  const d = size
    ? [
        `M ${size.w / 2} ${i}`,
        `H ${size.w - i - r}`,
        `A ${r} ${r} 0 0 1 ${size.w - i} ${i + r}`,
        `V ${size.h - i - r}`,
        `A ${r} ${r} 0 0 1 ${size.w - i - r} ${size.h - i}`,
        `H ${i + r}`,
        `A ${r} ${r} 0 0 1 ${i} ${size.h - i - r}`,
        `V ${i + r}`,
        `A ${r} ${r} 0 0 1 ${i + r} ${i}`,
        `H ${size.w / 2}`,
      ].join(" ")
    : "";

  return (
    <svg
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute -inset-px overflow-visible"
      width={size?.w ?? 0}
      height={size?.h ?? 0}
    >
      {d && (
        <path
          d={d}
          fill="none"
          stroke="#00e39b"
          strokeWidth="1.5"
          pathLength={1}
          strokeDasharray="1"
          strokeDashoffset={1 - progress}
          opacity={progress > 0 ? 0.9 : 0}
        />
      )}
    </svg>
  );
}

/** How far along the rail the fill has got, and where a travelling pulse is (if any). */
function railProgress(t: number): {fill: number; pulse: number | null} {
  // Stage centres sit at 0, 1/3, 2/3 and 1 of the rail.
  for (let k = 0; k < CONNECT.length; k++) {
    const [a, b] = CONNECT[k]!;
    if (t >= a && t < b) {
      const p = easeInOut((t - a) / (b - a));
      const x = (k + p) / 3;
      return {fill: x, pulse: x};
    }
  }
  const reached = ON.filter((at) => t >= at).length;
  return {fill: Math.max(0, (reached - 1) / 3), pulse: null};
}

function Node({
  index,
  on,
  done,
  sealed,
  ripple,
  run,
}: {
  index: number;
  on: boolean;
  done: boolean;
  sealed: boolean;
  ripple: boolean;
  run: number;
}) {
  return (
    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
      <div
        className={`relative flex h-6 w-6 items-center justify-center rounded-full border text-[0.65rem] font-semibold transition-all duration-300 ${
          done
            ? "border-up/60 bg-up/15 text-up"
            : on
              ? "border-acc bg-acc/15 text-acc-hi"
              : "border-edge bg-ink-950 text-txt-lo"
        } ${sealed ? "shadow-[0_0_16px_-2px_rgba(0,227,155,0.55)]" : ""}`}
      >
        {done ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        ) : (
          index + 1
        )}
        {ripple && (
          <span key={run} className="ripple absolute inset-0 rounded-full border border-up" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

function Terms({on}: {on: boolean}) {
  const rows: [string, string][] = [
    ["drawdown", "5% trailing"],
    ["daily loss", "3%"],
    ["position", "3× allocation"],
  ];
  return (
    <div className="space-y-1">
      {rows.map(([k, v], i) => (
        <div
          key={k}
          className="num flex justify-between text-2xs transition-opacity duration-300"
          style={{opacity: on ? 1 : 0.35, transitionDelay: `${on ? 120 + i * 90 : 0}ms`}}
        >
          <span className="text-txt-lo">{k}</span>
          <span className="text-txt-mid">{v}</span>
        </div>
      ))}
      <div className="flex items-center gap-1.5 pt-1 text-2xs text-txt-lo">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
        no function to change them
      </div>
    </div>
  );
}

/** Allowance used, filling to where a clean session actually ends up. */
function RiskBars({t}: {t: number}) {
  const p = easeOut(phase(t, ON[1]! + 150, 800));
  const bars: [string, number][] = [
    ["drawdown used", 0.34],
    ["daily used", 0.12],
  ];
  return (
    <div className="space-y-2">
      {bars.map(([k, v]) => (
        <div key={k}>
          <div className="num flex justify-between text-2xs">
            <span className="text-txt-lo">{k}</span>
            <span className="text-txt-mid">{Math.round(v * p * 100)}%</span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-ink-800">
            <div className="h-full rounded-full bg-up" style={{width: `${v * p * 100}%`}} />
          </div>
        </div>
      ))}
      <div className="num text-2xs text-txt-lo">breaches: 0</div>
    </div>
  );
}

/** The record the contract writes on settlement, arriving field by field. */
function Record({t}: {t: number}) {
  const base = ON[2]! + 150;
  const fields: [string, string, number][] = [
    ["settled", "1", base],
    ["breaches", "0", base + 140],
    ["profitable exits", "1", base + 280],
  ];
  const confirmed = t >= base + 480;
  return (
    <div className="space-y-1">
      {fields.map(([k, v, at]) => (
        <div key={k} className="num flex justify-between text-2xs">
          <span className="text-txt-lo">{k}</span>
          <span className="text-txt-hi transition-opacity duration-200" style={{opacity: t >= at ? 1 : 0}}>
            {v}
          </span>
        </div>
      ))}
      <div
        className={`flex items-center gap-1.5 pt-1 text-2xs transition-colors duration-300 ${
          confirmed ? "text-up" : "text-txt-lo"
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${confirmed ? "bg-up" : "bg-ink-500"}`} />
        {confirmed ? "confirmed on Monad" : "settling…"}
      </div>
    </div>
  );
}

/** The new account's numbers: they arrive once, then hold. */
function FundedMetrics({live}: {live: boolean}) {
  const usd0 = (n: number) =>
    n.toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0});
  return (
    <div className="space-y-1">
      <Metric k="allocation" v={<CountUp value={live ? 50_000 : undefined} format={usd0} duration={650} />} />
      <Metric k="floor" v={<CountUp value={live ? 47_500 : undefined} format={usd0} duration={650} />} />
      <Metric k="to trader" v={<CountUp value={live ? 80 : undefined} format={(n) => `${Math.round(n)}%`} duration={650} />} />
      <div
        className={`flex items-center gap-1.5 pt-1 text-2xs transition-colors duration-500 ${live ? "text-up" : "text-txt-lo"}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-up" : "bg-ink-500"}`} />
        {live ? "live under enforced terms" : "awaiting capital"}
      </div>
    </div>
  );
}

function Metric({k, v}: {k: string; v: React.ReactNode}) {
  return (
    <div className="num flex justify-between text-2xs">
      <span className="text-txt-lo">{k}</span>
      <span className="text-txt-hi">{v}</span>
    </div>
  );
}

/** The LP vault above the funded stage, and the capital line it sends down. */
function Vault({capital, active}: {capital: number; active: boolean}) {
  return (
    <div className="flex flex-col items-center">
      <div
        className={`num rounded-md border px-2.5 py-1 text-[0.6rem] uppercase tracking-[0.14em] transition-colors duration-300 ${
          active ? "border-acc/50 bg-acc/10 text-acc-hi" : "border-edge bg-ink-950 text-txt-lo"
        }`}
      >
        LP vault · $50,000
      </div>
      <svg width="2" height="34" aria-hidden="true" className="overflow-visible">
        <line x1="1" y1="0" x2="1" y2="34" stroke="#252c3a" strokeWidth="1.5" />
        <line
          x1="1"
          y1="0"
          x2="1"
          y2="34"
          stroke="#5195ff"
          strokeWidth="2"
          strokeDasharray="34"
          strokeDashoffset={34 * (1 - capital)}
        />
        {capital > 0 && capital < 1 && <circle cx="1" cy={34 * capital} r="3" fill="#5195ff" />}
      </svg>
    </div>
  );
}

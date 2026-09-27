/**
 * The terminal the hero sits on.
 *
 * A faint grid, two market traces and a row of candles drifting left, and the occasional
 * transaction pulse crossing a grid line. It is texture, so it stays at the edge of
 * perception: nothing here competes with the headline or the engine diagram for attention.
 *
 * Everything is CSS-animated — zero JavaScript per frame — and the traces come from a fixed
 * seed, so the page is identical on every load. A backdrop that re-randomises itself is
 * the opposite of what this product is about.
 */

const W = 1200; // one tile; the drifting group holds two, and translates by exactly one
const H = 520;

/** Small, fast, seeded PRNG — the same walk on every render, server and client alike. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A price walk that ends where it starts, so two tiles side by side join without a step.
 * The drift is removed linearly after generation, which keeps the walk's texture intact.
 */
function walk(seed: number, n: number, amp: number): number[] {
  const rnd = mulberry32(seed);
  const ys = [0];
  for (let i = 1; i < n; i++) ys.push(ys[i - 1]! + (rnd() - 0.5) * amp);
  const drift = ys[n - 1]! - ys[0]!;
  return ys.map((y, i) => y - (drift * i) / (n - 1));
}

function tracePath(seed: number, baseY: number, amp: number): string {
  const n = 60;
  const ys = walk(seed, n, amp);
  const step = W / (n - 1);
  const one = ys.map((y, i) => `${(i * step).toFixed(1)} ${(baseY + y).toFixed(1)}`);
  const two = ys.map((y, i) => `${(W + i * step).toFixed(1)} ${(baseY + y).toFixed(1)}`);
  return `M ${one.join(" L ")} L ${two.join(" L ")}`;
}

type Candle = {x: number; open: number; close: number; high: number; low: number};

function candles(seed: number, baseY: number): Candle[] {
  const n = 48;
  const ys = walk(seed, n + 1, 18);
  const rnd = mulberry32(seed * 7 + 3);
  const out: Candle[] = [];
  for (let tile = 0; tile < 2; tile++) {
    for (let i = 0; i < n; i++) {
      const open = baseY + ys[i]!;
      const close = baseY + ys[i + 1]!;
      const wick = 2 + rnd() * 6;
      out.push({
        x: tile * W + (i * W) / n + 6,
        open,
        close,
        high: Math.min(open, close) - wick,
        low: Math.max(open, close) + wick * 0.8,
      });
    }
  }
  return out;
}

const TRACE_A = tracePath(11, 150, 26);
const TRACE_B = tracePath(29, 330, 18);
const CANDLES = candles(5, 430);

/** Grid rows the pulses travel along, with their own period and offset. */
const PULSES = [
  {y: 96, dur: 11, delay: 0.5},
  {y: 224, dur: 14, delay: 4.2},
  {y: 352, dur: 12, delay: 7.8},
  {y: 480, dur: 16, delay: 2.4},
];

export function HeroBackdrop() {
  return (
    // Full-bleed: the terminal runs past the text column to the edges of the window, and
    // fades out before reaching them. `closest-side` makes the mask reach transparent
    // exactly at the nearest edge, so no side of the box can show as a hard line.
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-1/2 w-screen -translate-x-1/2 overflow-hidden"
      style={{
        backgroundImage:
          "linear-gradient(#10141c 1px, transparent 1px), linear-gradient(90deg, #10141c 1px, transparent 1px)",
        backgroundSize: "32px 32px",
        backgroundPosition: "center top",
        maskImage: "radial-gradient(closest-side at 50% 40%, black 40%, transparent 100%)",
        WebkitMaskImage: "radial-gradient(closest-side at 50% 40%, black 40%, transparent 100%)",
      }}
    >
      {/* Native size, never scaled: stretched to a tall hero, the traces thickened and the
          pulses drifted off their grid lines. */}
      <svg className="absolute left-1/2 top-10 -translate-x-1/2" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <g className="hb-drift">
          <path d={TRACE_A} fill="none" stroke="#2f7dfb" strokeOpacity="0.11" strokeWidth="1.2" />
        </g>
        <g className="hb-drift-slow">
          <path d={TRACE_B} fill="none" stroke="#00e39b" strokeOpacity="0.08" strokeWidth="1" />
          {CANDLES.map((c, i) => (
            <g key={i} opacity="0.1">
              <line x1={c.x} x2={c.x} y1={c.high} y2={c.low} stroke={c.close <= c.open ? "#00e39b" : "#ff3d55"} strokeWidth="1" />
              <rect
                x={c.x - 3}
                y={Math.min(c.open, c.close)}
                width="6"
                height={Math.max(1.2, Math.abs(c.close - c.open))}
                fill={c.close <= c.open ? "#00e39b" : "#ff3d55"}
              />
            </g>
          ))}
        </g>

        {/* Transactions crossing the grid — occasional by construction: each is on screen
            for a quarter of its own period. */}
        {PULSES.map((p, i) => (
          <g key={i} className="hb-pulse" style={{animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s`}}>
            <line x1={-60} x2={0} y1={p.y} y2={p.y} stroke="#5195ff" strokeOpacity="0.5" strokeWidth="1" />
            <circle cx={0} cy={p.y} r="1.8" fill="#5195ff" />
          </g>
        ))}
      </svg>
    </div>
  );
}

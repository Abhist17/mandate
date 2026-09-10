"use client";

import type {ReactNode} from "react";

export function Panel({
  title,
  right,
  children,
  className = "",
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <header className="panel-head">
          <h2 className="panel-title">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
  size = "md",
  emphasis = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "neutral" | "up" | "down" | "warn";
  size?: "md" | "lg" | "xl" | "hero";
  /** Adds a glow. Reserved for the single number the screen is really about. */
  emphasis?: boolean;
}) {
  const toneClass =
    tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : "text-txt-hi";
  const sizeClass =
    size === "hero"
      ? "text-[2.6rem] leading-none"
      : size === "xl"
        ? "text-3xl leading-none"
        : size === "lg"
          ? "text-xl"
          : "text-sm";
  const glow =
    emphasis && tone === "down"
      ? "drop-shadow-[0_0_18px_rgba(255,61,85,0.45)]"
      : emphasis && tone === "up"
        ? "drop-shadow-[0_0_18px_rgba(0,227,155,0.4)]"
        : emphasis && tone === "warn"
          ? "drop-shadow-[0_0_18px_rgba(255,180,58,0.4)]"
          : "";
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`figure font-mono mt-1.5 ${sizeClass} ${toneClass} ${glow}`}>{value}</div>
      {sub && <div className="mt-1 text-2xs text-txt-lo">{sub}</div>}
    </div>
  );
}

export function StatusPill({status}: {status: number}) {
  const map: Record<number, {label: string; cls: string}> = {
    0: {label: "Unknown", cls: "border-ink-600 bg-ink-800 text-txt-lo"},
    1: {label: "Active", cls: "border-up/30 bg-up/10 text-up"},
    2: {label: "Breached", cls: "border-down/40 bg-down/10 text-down"},
    3: {label: "Expired", cls: "border-warn/30 bg-warn/10 text-warn"},
    4: {label: "Closed", cls: "border-ink-600 bg-ink-800 text-txt-mid"},
  };
  const s = map[status] ?? map[0]!;
  return (
    <span
      className={`rounded-md border px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.1em] ${s.cls}`}
    >
      {s.label}
    </span>
  );
}

/**
 * The headroom bar.
 *
 * Shows where equity sits between the floor (empty) and the high-water mark (full). It turns
 * amber then red as the gap closes, because a number alone does not convey urgency fast
 * enough when it is the number that decides whether you are still funded.
 */
export function HeadroomBar({
  equity,
  floor,
  peak,
}: {
  equity: number;
  floor: number;
  peak: number;
}) {
  const span = Math.max(peak - floor, 1e-9);
  const pct = Math.max(0, Math.min(100, ((equity - floor) / span) * 100));
  const tone =
    pct <= 0
      ? "bg-down shadow-glow-down"
      : pct < 20
        ? "bg-down shadow-glow-down"
        : pct < 45
          ? "bg-warn"
          : "bg-up shadow-glow";
  const money = (v: number) =>
    v.toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0});
  return (
    <div className="space-y-1.5">
      <div className="h-2 w-full overflow-hidden rounded-full bg-ink-800 ring-1 ring-inset ring-white/[0.04]">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${tone}`}
          style={{width: `${pct}%`}}
        />
      </div>
      <div className="flex justify-between text-2xs">
        <span className="text-down">{money(floor)} floor</span>
        <span className="text-txt-lo">{money(peak)} peak</span>
      </div>
    </div>
  );
}

export function Field({label, value, mono = true}: {label: string; value: ReactNode; mono?: boolean}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <span className="text-xs text-txt-mid">{label}</span>
      <span className={`text-xs text-txt-hi ${mono ? "num" : ""}`}>{value}</span>
    </div>
  );
}

/**
 * A one-line explanation of what the reader is looking at.
 *
 * Added after the person who commissioned this could not tell what the screen was for.
 * If the author cannot, a stranger arriving from a Discord link certainly cannot — and the
 * traction target depends on strangers understanding it unaided.
 */
export function Explainer({children}: {children: ReactNode}) {
  return (
    <div className="rounded-xl border border-edge bg-gradient-to-b from-ink-900 to-ink-950 px-5 py-4 shadow-panel">
      {children}
    </div>
  );
}

export function LiveDot({on = true}: {on?: boolean}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-2xs text-txt-lo">
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "live-dot bg-up" : "bg-ink-500"}`} />
      {on ? "live" : "idle"}
    </span>
  );
}

export function Empty({children}: {children: ReactNode}) {
  return <div className="px-4 py-10 text-center text-sm text-txt-lo">{children}</div>;
}

/**
 * Loading placeholder shaped like the content it replaces.
 *
 * A skeleton that matches the eventual layout means the page does not jump when data lands.
 * "Loading…" as bare text is both less informative and more disruptive.
 */
export function Skeleton({className = ""}: {className?: string}) {
  return <div className={`animate-pulse rounded bg-white/[0.045] ${className}`} />;
}

export function SkeletonPanel({rows = 3, title}: {rows?: number; title?: string}) {
  return (
    <Panel title={title}>
      <div className="space-y-3 p-4">
        {Array.from({length: rows}).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    </Panel>
  );
}

/**
 * A signed value with a direction marker, not just a colour.
 *
 * Financial UIs universally use green for gain and red for loss, and breaking that convention
 * breaks trust — but colour alone excludes anyone with red-green colour blindness, which is
 * roughly one man in twelve. The arrow carries the same information without it.
 */
export function Signed({
  value,
  format,
  className = "",
}: {
  value: bigint;
  format: (v: bigint) => string;
  className?: string;
}) {
  const up = value >= 0n;
  const magnitude = up ? value : -value;
  return (
    <span className={`num ${up ? "text-up" : "text-down"} ${className}`}>
      <span aria-hidden="true">{up ? "▲" : "▼"}</span>
      <span className="sr-only">{up ? "up" : "down"} </span>
      {format(magnitude)}
    </span>
  );
}

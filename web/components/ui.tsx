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
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "neutral" | "up" | "down" | "warn";
  size?: "md" | "lg" | "xl";
}) {
  const toneClass =
    tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : "text-txt-hi";
  const sizeClass = size === "xl" ? "text-3xl" : size === "lg" ? "text-xl" : "text-sm";
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`num mt-1 ${sizeClass} ${toneClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-2xs text-txt-lo">{sub}</div>}
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
    <span className={`rounded border px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider ${s.cls}`}>
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
  const tone = pct <= 0 ? "bg-down" : pct < 20 ? "bg-down" : pct < 45 ? "bg-warn" : "bg-up";
  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
        <div className={`h-full rounded-full transition-all duration-500 ${tone}`} style={{width: `${pct}%`}} />
      </div>
      <div className="flex justify-between text-2xs text-txt-lo">
        <span>floor</span>
        <span>peak</span>
      </div>
    </div>
  );
}

export function Field({label, value, mono = true}: {label: string; value: ReactNode; mono?: boolean}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-xs text-txt-mid">{label}</span>
      <span className={`text-xs text-txt-hi ${mono ? "num" : ""}`}>{value}</span>
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

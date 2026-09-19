"use client";

/**
 * The controls that sit between the numbers and the chart.
 *
 * Deliberately two, not ten. A funded trader's chart has exactly two questions worth a
 * control — "show me the rules on it or not" and "in dollars or in percent" — and the
 * dashboards that earn their keep answer those two and stop. Anything else here is a
 * setting someone has to understand before they can read their own account.
 */

export type Unit = "abs" | "pct";

export function ChartControls({
  lines,
  onLines,
  unit,
  onUnit,
  right,
}: {
  lines: boolean;
  onLines: (v: boolean) => void;
  unit: Unit;
  onUnit: (v: Unit) => void;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-edge px-4 py-3">
      <Group label="Objective lines">
        <Segmented
          options={[
            {v: true, label: "On"},
            {v: false, label: "Off"},
          ]}
          value={lines}
          onChange={onLines}
        />
      </Group>

      <Group label="Values">
        <Segmented
          options={[
            {v: "abs" as Unit, label: "Absolute"},
            {v: "pct" as Unit, label: "Percent"},
          ]}
          value={unit}
          onChange={onUnit}
        />
      </Group>

      {right && <div className="ml-auto flex items-center gap-3">{right}</div>}
    </div>
  );
}

function Group({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-2xs uppercase tracking-[0.12em] text-txt-lo">{label}</span>
      {children}
    </div>
  );
}

function Segmented<T extends string | boolean>({
  options,
  value,
  onChange,
}: {
  options: {v: T; label: string}[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-lg border border-edge bg-ink-950 p-0.5">
      {options.map((o) => {
        const on = o.v === value;
        return (
          <button
            key={String(o.v)}
            onClick={() => onChange(o.v)}
            aria-pressed={on}
            className={`rounded-[7px] px-2.5 py-1 text-2xs font-medium transition-colors ${
              on ? "bg-acc text-white" : "text-txt-mid hover:text-txt-hi"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

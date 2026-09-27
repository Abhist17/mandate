"use client";

import {useEffect, useRef, useState} from "react";
import {clamp01, useScrollFrame} from "@/lib/motion";

/**
 * The line that runs down the left of the page and connects its sections.
 *
 * The page is one loop told in order — capital in, rules enforced, a breach closed, a record
 * funded, everything checkable — and the rail is that order made literal: it fills as you
 * read, and each section's node lights as it reaches the reading line. It is scroll-linked,
 * not timed, so it only ever moves when the reader does.
 *
 * Sections opt in with `data-rail="01"` and `data-rail-label`. Positions are measured from
 * the live layout on each scroll frame, so a section that grows (a chart loading, a font
 * swapping in) never leaves its node behind.
 */
type Node = {index: string; label: string; top: number};

export function SectionRail() {
  const ref = useRef<HTMLDivElement | null>(null);
  const fill = useRef<HTMLDivElement | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [lit, setLit] = useState(-1);
  const litRef = useRef(-1);
  const sig = useRef("");

  const update = () => {
    const host = ref.current?.parentElement;
    if (!host) return;
    const hostTop = host.getBoundingClientRect().top;
    const found: Node[] = [...host.querySelectorAll<HTMLElement>("[data-rail]")].map((el) => ({
      index: el.dataset.rail ?? "",
      label: el.dataset.railLabel ?? "",
      top: Math.round(el.getBoundingClientRect().top - hostTop + 10),
    }));
    if (found.length < 2) return;

    // Re-render only when the layout actually moved, not on every scroll frame.
    const s = found.map((n) => n.top).join(",");
    if (s !== sig.current) {
      sig.current = s;
      setNodes(found);
    }

    // The reading line: 45% down the viewport, in the rail's coordinates.
    const line = window.innerHeight * 0.45 - hostTop;
    const first = found[0]!.top;
    const last = found[found.length - 1]!.top;
    if (fill.current) fill.current.style.transform = `scaleY(${clamp01((line - first) / (last - first)).toFixed(4)})`;

    const reached = found.filter((n) => n.top <= line).length - 1;
    if (reached !== litRef.current) {
      litRef.current = reached;
      setLit(reached);
    }
  };

  useScrollFrame(update);
  // The fill element only exists once nodes have been measured, so the first pass cannot
  // position it. Run again when it appears, or an unscrolled page would show it empty.
  useEffect(update, [nodes.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const first = nodes[0]?.top ?? 0;
  const last = nodes[nodes.length - 1]?.top ?? 0;

  return (
    <div ref={ref} aria-hidden="true" className="pointer-events-none absolute -left-28 top-0 hidden h-full w-24 xl:block">
      {nodes.length > 1 && (
        <div className="absolute left-[7px] w-px bg-edge" style={{top: first, height: last - first}}>
          <div
            ref={fill}
            className="h-full w-full origin-top bg-gradient-to-b from-acc via-acc to-up"
            style={{transform: "scaleY(0)"}}
          />
        </div>
      )}
      {nodes.map((n, k) => {
        const on = k <= lit;
        return (
          <div key={n.index} className="absolute left-0 flex items-center gap-2.5" style={{top: n.top - 7}}>
            <span
              className={`relative h-[15px] w-[15px] rounded-full border transition-colors duration-300 ${
                on ? "border-acc bg-acc/25" : "border-edge-hi bg-ink-980"
              }`}
            >
              {on && <span className="absolute inset-[4px] rounded-full bg-acc-hi" />}
            </span>
            <span className={`num text-[0.6rem] leading-tight tracking-[0.12em] transition-colors duration-300 ${on ? "text-txt-mid" : "text-txt-lo/70"}`}>
              {n.index}
              <br />
              <span className="uppercase">{n.label}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
